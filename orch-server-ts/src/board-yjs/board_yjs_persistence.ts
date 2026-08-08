import { Database } from "@hocuspocus/extension-database";
import type {
  Extension,
  fetchPayload,
  onChangePayload,
  storePayload,
} from "@hocuspocus/server";
import * as Y from "yjs";

import {
  createBoardYDocSnapshot,
  parseBoardYjsDocumentName,
  readBoardYDocReplica,
} from "./board_yjs_model.js";
import {
  BOARD_YJS_SNAPSHOT_CAS_MAX_ATTEMPTS,
  BoardYjsSnapshotCasExhaustedError,
  mergeBoardYjsSnapshots,
  mergeYjsSnapshotUpdates,
  type BoardYjsSnapshotProjection,
  type BoardYjsSnapshotRecord,
} from "./board_yjs_snapshot_store.js";
import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  BoardYjsReplica,
  BoardYjsSeed,
} from "./board_yjs_types.js";

export interface BoardYjsPersistenceRepository {
  loadBoardYjsSnapshot(documentName: string): Promise<BoardYjsSnapshotRecord | null>;
  resolveBoardYjsContainerScope(
    container: BoardYjsContainerRef,
  ): Promise<BoardYjsContainerScope | null>;
  backfillTaskBoardItemsIntoSnapshot(
    documentName: string,
    container: BoardYjsContainerScope,
    snapshot: BoardYjsSnapshotRecord,
  ): Promise<BoardYjsSnapshotRecord>;
  loadBoardYjsSeed(container: BoardYjsContainerScope): Promise<BoardYjsSeed>;
  storeBoardYjsSnapshot(
    documentName: string,
    snapshot: Uint8Array,
    expectedRevision: number | null,
    projection?: BoardYjsSnapshotProjection,
  ): Promise<BoardYjsSnapshotRecord | null>;
  invalidateBoardYjsCatalogCache?(container: BoardYjsContainerScope): void;
  loadRawBoardYjsDocument?(documentName: string): Promise<BoardYjsRawDocument | null>;
  commitBoardYjsRunbookMigration?(input: BoardYjsRunbookMigrationCommit): Promise<void>;
  runBoardYjsRunbookMigrationTransaction?<T>(
    operation: (repository: BoardYjsPersistenceRepository) => Promise<T>,
  ): Promise<T>;
}

export interface BoardYjsRawDocument {
  snapshot: Uint8Array;
  revision: string;
}

export interface BoardYjsRunbookMigrationCommit {
  sourceDocumentName: string;
  canonicalDocumentName: string;
  expectedSourceRevision: string;
  expectedCanonicalRevision: string | null;
  canonicalSnapshot: Uint8Array;
  scope: BoardYjsContainerScope;
  replica: BoardYjsReplica;
  preserveCanonical: boolean;
}

export interface BoardYjsPersistence {
  database: Database;
  snapshotSync: Extension;
}

export function createBoardYjsPersistence(
  repository: BoardYjsPersistenceRepository,
): BoardYjsPersistence {
  return {
    database: new Database({
      fetch: async (payload: fetchPayload) => {
        const snapshot = await repository.loadBoardYjsSnapshot(payload.documentName);
        const container = parseBoardYjsDocumentName(payload.documentName);
        if (!container) return snapshot?.snapshot ?? null;
        const scope = await repository.resolveBoardYjsContainerScope(container);
        if (!scope) return snapshot?.snapshot ?? null;
        if (snapshot) {
          return (await repository.backfillTaskBoardItemsIntoSnapshot(
            payload.documentName,
            scope,
            snapshot,
          )).snapshot;
        }
        const seed = await repository.loadBoardYjsSeed(scope);
        const encoded = createBoardYDocSnapshot({
          ...scope,
          boardItems: seed.boardItems,
          markdownDocuments: seed.markdownDocuments,
        });
        const created = await repository.storeBoardYjsSnapshot(
          payload.documentName,
          encoded,
          null,
          {
            scope,
            replica: snapshotReplica(scope, encoded),
          },
        );
        if (created) return created.snapshot;
        const winner = await repository.loadBoardYjsSnapshot(payload.documentName);
        if (!winner) {
          throw new Error(`board Y.Doc bootstrap winner disappeared: ${payload.documentName}`);
        }
        return winner.snapshot;
      },
      store: async (payload: storePayload) => {
        const container = parseBoardYjsDocumentName(payload.documentName);
        const scope = container
          ? await repository.resolveBoardYjsContainerScope(container)
          : null;
        const stored = await mergeAndStoreBoardYjsSnapshot(
          repository,
          payload.documentName,
          payload.state,
          scope,
        );
        Y.applyUpdate(payload.document, stored.snapshot, "board-yjs-cas-merge");
      },
    }),
    snapshotSync: {
      extensionName: "soulstream-board-yjs-snapshot-sync",
      async onChange(payload: onChangePayload) {
        const container = parseBoardYjsDocumentName(payload.documentName);
        if (!container) return;
        const scope = await repository.resolveBoardYjsContainerScope(container);
        if (!scope) return;
        const snapshot = Y.encodeStateAsUpdate(payload.document);
        const stored = await mergeAndStoreBoardYjsSnapshot(
          repository,
          payload.documentName,
          snapshot,
          scope,
        );
        Y.applyUpdate(payload.document, stored.snapshot, "board-yjs-cas-merge");
        repository.invalidateBoardYjsCatalogCache?.(scope);
      },
    },
  };
}

async function mergeAndStoreBoardYjsSnapshot(
  repository: BoardYjsPersistenceRepository,
  documentName: string,
  candidateSnapshot: Uint8Array,
  scope: BoardYjsContainerScope | null,
): Promise<BoardYjsSnapshotRecord> {
  for (let attempt = 1; attempt <= BOARD_YJS_SNAPSHOT_CAS_MAX_ATTEMPTS; attempt += 1) {
    const current = await repository.loadBoardYjsSnapshot(documentName);
    const merged = scope
      ? mergeBoardYjsSnapshots(scope, current?.snapshot ?? null, candidateSnapshot)
      : {
          snapshot: mergeYjsSnapshotUpdates(current?.snapshot ?? null, candidateSnapshot),
          replica: null,
        };
    const stored = await repository.storeBoardYjsSnapshot(
      documentName,
      merged.snapshot,
      current?.revision ?? null,
      ...(scope && merged.replica
        ? [{ scope, replica: merged.replica }]
        : []),
    );
    if (stored) return stored;
  }
  throw new BoardYjsSnapshotCasExhaustedError(
    documentName,
    BOARD_YJS_SNAPSHOT_CAS_MAX_ATTEMPTS,
  );
}

function snapshotReplica(
  scope: BoardYjsContainerScope,
  snapshot: Uint8Array,
): BoardYjsReplica {
  const doc = new Y.Doc();
  if (snapshot.byteLength > 0) Y.applyUpdate(doc, snapshot);
  return readBoardYDocReplica(scope, doc);
}
