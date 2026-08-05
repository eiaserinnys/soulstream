import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { BOARD_ITEMS_MAP } from "../src/board-yjs/board_yjs_document.js";
import type {
  BoardYjsRawDocument,
  BoardYjsRunbookMigrationCommit,
} from "../src/board-yjs/board_yjs_persistence.js";
import { assertBoardItemProjectionParity } from
  "../src/board-yjs/board_yjs_projection_verification.js";
import {
  BoardYjsMigrationRevisionConflictError,
  computeBoardYjsRawRevision,
} from "../src/board-yjs/board_yjs_raw_document.js";
import {
  executeQuiescedBoardYjsRunbookMigration,
  executeQuiescedBoardYjsRunbookMigrationBatch,
} from
  "../src/board-yjs/board_yjs_runbook_migration.js";
import { createBoardYjsRunbookMigrationPlan } from
  "../src/board-yjs/board_yjs_runbook_plan.js";
import type {
  BoardYjsContainerScope,
  BoardYjsReplica,
  CatalogBoardItemRow,
} from "../src/board-yjs/board_yjs_types.js";

describe("approval-gated board Y.Doc runbook migration", () => {
  it("commits every document in one transaction", async () => {
    const repository = new MigrationRepositoryDouble();
    repository.documents.set(
      "board-folder:folder-a",
      rawDocument(snapshotWithItem("session:a", "session-a", "runbook")),
    );
    repository.documents.set(
      "board-folder:folder-b",
      rawDocument(snapshotWithItem("session:b", "session-b", "runbook")),
    );
    const requests = ["board-folder:folder-a", "board-folder:folder-b"].map(
      (documentName) => {
        const plan = currentPlan(repository, documentName);
        return {
          documentName,
          planFingerprint: plan.planFingerprint,
          opaqueBoardItemIds: plan.opaqueBoardItemIds,
        };
      },
    );

    await executeQuiescedBoardYjsRunbookMigrationBatch({ requests, repository });

    expect(repository.transactionCalls).toBe(1);
    expect(repository.commitCalls).toBe(2);
  });

  it("rolls back every document when a later document fails", async () => {
    const repository = new MigrationRepositoryDouble();
    repository.documents.set(
      "board-folder:folder-a",
      rawDocument(snapshotWithItem("session:a", "session-a", "runbook")),
    );
    repository.documents.set(
      "board-folder:folder-b",
      rawDocument(snapshotWithItem("session:b", "session-b", "runbook")),
    );
    const before = new Map(repository.documents);
    const first = currentPlan(repository, "board-folder:folder-a");
    const second = currentPlan(repository, "board-folder:folder-b");

    await expect(executeQuiescedBoardYjsRunbookMigrationBatch({
      requests: [
        {
          documentName: first.sourceDocumentName,
          planFingerprint: first.planFingerprint,
          opaqueBoardItemIds: first.opaqueBoardItemIds,
        },
        {
          documentName: second.sourceDocumentName,
          planFingerprint: "stale-fingerprint",
          opaqueBoardItemIds: second.opaqueBoardItemIds,
        },
      ],
      repository,
    })).rejects.toThrow("plan fingerprint mismatch");

    expect(repository.transactionCalls).toBe(1);
    expect(repository.documents).toEqual(before);
  });

  it("treats an empty migration batch as a successful no-op", async () => {
    const repository = new MigrationRepositoryDouble();

    await expect(executeQuiescedBoardYjsRunbookMigrationBatch({
      requests: [],
      repository,
    })).resolves.toEqual([]);

    expect(repository.transactionCalls).toBe(0);
    expect(repository.commitCalls).toBe(0);
  });

  it("leaves the canonical document untouched when preflight validation fails", async () => {
    const repository = new MigrationRepositoryDouble();
    repository.documents.set(
      "board:runbook:task-a",
      rawDocument(snapshotWithItem("runbook:task-a", "legacy", "runbook")),
    );
    const plan = currentPlan(repository, "board:runbook:task-a");

    await expect(executeQuiescedBoardYjsRunbookMigration({
      request: {
        documentName: "board:runbook:task-a",
        planFingerprint: plan.planFingerprint,
        opaqueBoardItemIds: [],
      },
      repository,
    })).rejects.toThrow("allowlist mismatch");

    expect(repository.commitCalls).toBe(0);
    expect(repository.documents.has("board:task:task-a")).toBe(false);
    expect(repository.documents.has("board:runbook:task-a")).toBe(true);
  });

  it("retries only the raced document when its semantic plan is unchanged", async () => {
    const repository = new MigrationRepositoryDouble();
    repository.documents.set(
      "board-folder:folder-a",
      rawDocument(snapshotWithItem("session:a", "session-a", "runbook")),
    );
    repository.injectRevisionRaceOnce = true;
    const plan = currentPlan(repository, "board-folder:folder-a");

    const result = await executeQuiescedBoardYjsRunbookMigration({
      request: {
        documentName: "board-folder:folder-a",
        planFingerprint: plan.planFingerprint,
        opaqueBoardItemIds: [],
      },
      repository,
    });

    expect(result.attempts).toBe(2);
    expect(repository.commitCalls).toBe(2);
    const persisted = repository.documents.get("board-folder:folder-a")!;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, persisted.snapshot);
    expect(doc.getMap<Record<string, unknown>>(BOARD_ITEMS_MAP).get("session:a"))
      .toMatchObject({ item_type: "task" });
  });

  it("blocks non-equivalent collisions unless the dry-run content hash is approved", async () => {
    const repository = new MigrationRepositoryDouble();
    repository.documents.set(
      "board:runbook:task-a",
      rawDocument(snapshotWithItem("runbook:task-a", "legacy", "runbook")),
    );
    repository.documents.set(
      "board:task:task-a",
      rawDocument(snapshotWithItem("runbook:task-a", "canonical", "task")),
    );
    const plan = currentPlan(repository, "board:runbook:task-a");
    expect(plan.targetEquivalent).toBe(false);
    expect(plan.collisionDifferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surface: "board_item",
        id: "runbook:task-a",
        path: "item_id",
        legacyValue: '"legacy"',
        canonicalValue: '"canonical"',
      }),
    ]));

    await expect(executeQuiescedBoardYjsRunbookMigration({
      request: {
        documentName: "board:runbook:task-a",
        planFingerprint: plan.planFingerprint,
        opaqueBoardItemIds: plan.opaqueBoardItemIds,
      },
      repository,
    })).rejects.toThrow("requires explicit content hash approval");
    expect(repository.commitCalls).toBe(0);

    const result = await executeQuiescedBoardYjsRunbookMigration({
      request: {
        documentName: "board:runbook:task-a",
        planFingerprint: plan.planFingerprint,
        opaqueBoardItemIds: plan.opaqueBoardItemIds,
        approvedCollisionContentHash: plan.collisionContentHash,
      },
      repository,
    });
    expect(result.targetCollision).toBe(true);
    expect(repository.documents.has("board:runbook:task-a")).toBe(false);
    expect(repository.documents.has("board:task:task-a")).toBe(true);
  });
});

describe("board Y.Doc projection verification", () => {
  const item: CatalogBoardItemRow = {
    id: "session:a",
    folderId: "folder-a",
    containerKind: "folder",
    containerId: "folder-a",
    membershipKind: "primary",
    sourceTaskItemId: null,
    itemType: "session",
    itemId: "a",
    x: 1,
    y: 2,
    metadata: { title: "kept" },
  };

  it("compares IDs and core fields rather than residue counts alone", () => {
    expect(() => assertBoardItemProjectionParity({
      label: "same",
      ydocItems: [item],
      projectionItems: [{ ...item }],
    })).not.toThrow();
    expect(() => assertBoardItemProjectionParity({
      label: "lost",
      ydocItems: [item],
      projectionItems: [{ ...item, metadata: { title: "changed" } }],
    })).toThrow("projection mismatch");
  });
});

class MigrationRepositoryDouble {
  documents = new Map<string, BoardYjsRawDocument>();
  commitCalls = 0;
  transactionCalls = 0;
  injectRevisionRaceOnce = false;

  async runBoardYjsRunbookMigrationTransaction<T>(
    operation: (repository: MigrationRepositoryDouble) => Promise<T>,
  ): Promise<T> {
    this.transactionCalls += 1;
    const committedDocuments = this.documents;
    this.documents = new Map(committedDocuments);
    try {
      return await operation(this);
    } catch (error) {
      this.documents = committedDocuments;
      throw error;
    }
  }

  async loadRawBoardYjsDocument(name: string): Promise<BoardYjsRawDocument | null> {
    return this.documents.get(name) ?? null;
  }

  async commitBoardYjsRunbookMigration(
    input: BoardYjsRunbookMigrationCommit,
  ): Promise<void> {
    this.commitCalls += 1;
    if (this.injectRevisionRaceOnce) {
      this.injectRevisionRaceOnce = false;
      const current = this.documents.get(input.sourceDocumentName)!;
      const emptyUpdate = Y.encodeStateAsUpdate(new Y.Doc());
      this.documents.set(input.sourceDocumentName, rawDocument(
        current.snapshot,
        [...current.updates, emptyUpdate],
      ));
      throw new BoardYjsMigrationRevisionConflictError(input.sourceDocumentName);
    }
    const source = this.documents.get(input.sourceDocumentName);
    const canonical = this.documents.get(input.canonicalDocumentName);
    if (source?.revision !== input.expectedSourceRevision ||
      (input.sourceDocumentName !== input.canonicalDocumentName &&
        (canonical?.revision ?? null) !== input.expectedCanonicalRevision)) {
      throw new BoardYjsMigrationRevisionConflictError(input.sourceDocumentName);
    }
    if (!input.preserveCanonical) {
      this.documents.set(
        input.canonicalDocumentName,
        rawDocument(input.canonicalSnapshot),
      );
    }
    if (input.sourceDocumentName !== input.canonicalDocumentName) {
      this.documents.delete(input.sourceDocumentName);
    }
  }

  async resolveBoardYjsContainerScope(): Promise<BoardYjsContainerScope> {
    return { folderId: "folder-a", containerKind: "task", containerId: "task-a" };
  }

  async getBoardYjsSnapshot(): Promise<Uint8Array | null> { return null; }
  async backfillTaskBoardItemsIntoSnapshot(
    _name: string,
    _scope: BoardYjsContainerScope,
    snapshot: Uint8Array,
  ): Promise<Uint8Array> { return snapshot; }
  async loadBoardYjsSeed() { return { boardItems: [], markdownDocuments: [] }; }
  async storeBoardYjsSnapshot(): Promise<void> {}
  async markBoardYjsDocumentSynced(): Promise<void> {}
  async appendBoardYjsUpdate(): Promise<void> {}
  async syncBoardYjsReplica(
    _scope: BoardYjsContainerScope,
    _replica: BoardYjsReplica,
  ): Promise<void> {}
}

function currentPlan(repository: MigrationRepositoryDouble, sourceDocumentName: string) {
  const source = repository.documents.get(sourceDocumentName)!;
  const canonicalName = sourceDocumentName.startsWith("board:runbook:")
    ? `board:task:${sourceDocumentName.slice("board:runbook:".length)}`
    : sourceDocumentName;
  return createBoardYjsRunbookMigrationPlan({
    sourceDocumentName,
    source,
    canonical: canonicalName === sourceDocumentName
      ? null
      : repository.documents.get(canonicalName) ?? null,
  }).plan;
}

function rawDocument(
  snapshot: Uint8Array,
  updates: Uint8Array[] = [],
): BoardYjsRawDocument {
  return {
    snapshot,
    updates,
    revision: computeBoardYjsRawRevision(snapshot, updates),
  };
}

function snapshotWithItem(
  boardItemId: string,
  itemId: string,
  itemType: "runbook" | "task",
): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap<Record<string, unknown>>(BOARD_ITEMS_MAP).set(boardItemId, {
    item_type: itemType,
    item_id: itemId,
    x: 0,
    y: 0,
  });
  return Y.encodeStateAsUpdate(doc);
}
