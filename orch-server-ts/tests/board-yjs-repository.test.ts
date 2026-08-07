import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createBoardYDocSnapshot, readBoardYDocReplica } from "../src/board-yjs/board_yjs_model.js";
import { BoardYjsRepository } from "../src/board-yjs/board_yjs_repository.js";
import { assertBoardItemProjectionParity } from
  "../src/board-yjs/board_yjs_projection_verification.js";
import { normalizeMissingSourceTaskItemReferences } from
  "../src/board-yjs/board_yjs_replica_normalization.js";
import { computeBoardYjsRawRevision } from
  "../src/board-yjs/board_yjs_raw_document.js";
import {
  createLiveDbSqlResolver,
  type LivePostgresSql,
} from "../src/runtime/live_db_sql.js";

interface SqlCall {
  query: string;
  values: unknown[];
  inTransaction: boolean;
}

function createMockSql(resultFor?: (call: SqlCall) => readonly Record<string, unknown>[]) {
  const calls: SqlCall[] = [];
  const jsonValues: unknown[] = [];
  let inTransaction = false;
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { query: Array.from(strings).join("?"), values, inTransaction };
      calls.push(call);
      return Promise.resolve(resultFor?.(call) ?? []);
    },
    {
      array: (values: readonly unknown[]) => values,
      json: (value: unknown) => {
        jsonValues.push(value);
        return value;
      },
      begin: async <T>(callback: (transaction: LivePostgresSql) => Promise<T>) => {
        inTransaction = true;
        try {
          const transaction = Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => sql(strings, ...values),
            {
              array: (values: readonly unknown[]) => values,
              json: (value: unknown) => {
                jsonValues.push(value);
                return value;
              },
            },
          ) as unknown as LivePostgresSql;
          return await callback(transaction);
        } finally {
          inTransaction = false;
        }
      },
    },
  ) as unknown as LivePostgresSql;
  return { sql, calls, jsonValues };
}

describe("orch BoardYjsRepository", () => {
  it("loads a legacy document by its exact raw name from the snapshot only", async () => {
    const snapshot = Buffer.from([1, 2, 3]);
    const { sql, calls } = createMockSql((call) => {
      if (call.query.includes("FROM board_yjs_documents")) return [{ snapshot }];
      return [];
    });
    const repository = new BoardYjsRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    const state = await repository.loadRawBoardYjsDocument("board:runbook:task-a");

    expect(state).toEqual({
      snapshot: new Uint8Array(snapshot),
      revision: computeBoardYjsRawRevision(new Uint8Array(snapshot)),
    });
    expect(calls[0]?.query).toContain("REPEATABLE READ, READ ONLY");
    expect(calls.slice(1).every((call) => call.inTransaction)).toBe(true);
    expect(calls[1]?.values).toEqual(["board:runbook:task-a"]);
    expect(calls).toHaveLength(2);
  });

  it("rechecks a locked source revision before atomically writing and retiring it", async () => {
    const sourceSnapshot = Buffer.from([1, 2, 3]);
    const expectedRevision = computeBoardYjsRawRevision(
      new Uint8Array(sourceSnapshot),
    );
    const { sql, calls } = createMockSql((call) => {
      if (call.query.includes("SELECT snapshot") &&
        call.values[0] === "board:runbook:task-a") return [{ snapshot: sourceSnapshot }];
      if (call.query.includes("RETURNING name")) return [{ name: "board:task:task-a" }];
      return [];
    });
    const repository = new BoardYjsRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await repository.commitBoardYjsRunbookMigration({
      sourceDocumentName: "board:runbook:task-a",
      canonicalDocumentName: "board:task:task-a",
      expectedSourceRevision: expectedRevision,
      expectedCanonicalRevision: null,
      canonicalSnapshot: new Uint8Array([9]),
      scope: {
        folderId: "folder-1",
        containerKind: "task",
        containerId: "task-a",
      },
      replica: { boardItems: [], markdownDocuments: [] },
      preserveCanonical: false,
    });

    expect(calls.some((call) => call.query.includes("FOR UPDATE"))).toBe(true);
    expect(calls.some((call) => call.query.includes("ON CONFLICT (name) DO NOTHING")))
      .toBe(true);
    expect(calls.some((call) =>
      call.query.includes("DELETE FROM board_yjs_documents") &&
      call.values.includes("board:runbook:task-a")
    )).toBe(true);
    expect(calls.every((call) => call.inTransaction)).toBe(true);
  });

  it("keeps an approved canonical collision and synchronizes its SQL projection atomically", async () => {
    const sourceSnapshot = Buffer.from([1]);
    const canonicalSnapshot = Buffer.from([2]);
    const { sql, calls } = createMockSql((call) => {
      if (!call.query.includes("SELECT snapshot")) return [];
      if (call.values[0] === "board:runbook:task-a") return [{ snapshot: sourceSnapshot }];
      if (call.values[0] === "board:task:task-a") return [{ snapshot: canonicalSnapshot }];
      return [];
    });
    const repository = new BoardYjsRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await repository.commitBoardYjsRunbookMigration({
      sourceDocumentName: "board:runbook:task-a",
      canonicalDocumentName: "board:task:task-a",
      expectedSourceRevision: computeBoardYjsRawRevision(
        new Uint8Array(sourceSnapshot),
      ),
      expectedCanonicalRevision: computeBoardYjsRawRevision(
        new Uint8Array(canonicalSnapshot),
      ),
      canonicalSnapshot: new Uint8Array([9]),
      scope: { folderId: "folder-1", containerKind: "task", containerId: "task-a" },
      replica: { boardItems: [], markdownDocuments: [] },
      preserveCanonical: true,
    });

    expect(calls.some((call) => call.query.includes("INSERT INTO board_yjs_catalog_cache")))
      .toBe(true);
    expect(calls.some((call) => call.query.includes("RETURNING name"))).toBe(false);
    expect(calls.some((call) =>
      call.query.includes("DELETE FROM board_yjs_documents") &&
      call.values.includes("board:runbook:task-a")
    )).toBe(true);
    expect(calls.every((call) => call.inTransaction)).toBe(true);
  });

  it("reconciles one Y.Doc replica with transaction-scoped SET-DIFF and object JSONB", async () => {
    const { sql, calls, jsonValues } = createMockSql();
    const factory = vi.fn(() => sql);
    const resolver = createLiveDbSqlResolver({
      databaseUrl: "postgres://orch@localhost/orch",
      postgresFactory: factory,
    });
    const repository = new BoardYjsRepository(resolver);
    const scope = {
      folderId: "folder-1",
      containerKind: "task" as const,
      containerId: "rb-1",
    };
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createBoardYDocSnapshot({
      ...scope,
      boardItems: [{
        id: "markdown:d1",
        folderId: "folder-1",
        containerKind: "task",
        containerId: "rb-1",
        membershipKind: "primary",
        sourceTaskItemId: null,
        itemType: "markdown",
        itemId: "d1",
        x: 280,
        y: 160,
        metadata: { title: "Note" },
      }],
      markdownDocuments: [{ id: "d1", title: "Note", body: "Body", version: 3 }],
    }));
    const replica = readBoardYDocReplica(scope, doc);

    await repository.syncBoardYjsReplica(scope, replica);

    expect(factory).toHaveBeenCalledWith(
      "postgres://orch@localhost/orch",
      { max: 10, connection: { statement_timeout: 30_000 } },
    );
    expect(calls.map((call) => call.query)).toEqual([
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("DELETE FROM board_items"),
      expect.stringContaining("INSERT INTO board_items"),
      expect.stringContaining("INSERT INTO markdown_documents"),
      expect.stringContaining("INSERT INTO board_yjs_catalog_cache"),
      expect.stringContaining("UPDATE board_yjs_documents"),
    ]);
    expect(calls.every((call) => call.inTransaction)).toBe(true);
    expect(jsonValues).toEqual([
      { title: "Note", version: 3 },
      replica.boardItems,
      replica.markdownDocuments,
    ]);
    expect(jsonValues.every((value) => typeof value !== "string")).toBe(true);
  });

  it("normalizes deleted task item references identically for sync and verification", async () => {
    const danglingSourceTaskItemId = "missing-task-item";
    const existingSourceTaskItemId = "existing-task-item";
    const { sql, calls, jsonValues } = createMockSql((call) => {
      if (call.query.includes("FROM task_items")) return [{ id: existingSourceTaskItemId }];
      if (
        call.query.includes("INSERT INTO board_items") &&
        call.values[5] === danglingSourceTaskItemId
      ) {
        throw new Error(
          'violates foreign key constraint "board_items_source_runbook_item_id_fkey"',
        );
      }
      return [];
    });
    const repository = new BoardYjsRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });
    const replica = {
      boardItems: [{
        id: "session:poisoned",
        folderId: "folder-1",
        containerKind: "task" as const,
        containerId: "task-1",
        membershipKind: "primary" as const,
        sourceTaskItemId: danglingSourceTaskItemId,
        itemType: "session" as const,
        itemId: "poisoned",
        x: 0,
        y: 0,
        metadata: {},
      }, {
        id: "session:valid",
        folderId: "folder-1",
        containerKind: "task" as const,
        containerId: "task-1",
        membershipKind: "primary" as const,
        sourceTaskItemId: existingSourceTaskItemId,
        itemType: "session" as const,
        itemId: "valid",
        x: 10,
        y: 10,
        metadata: {},
      }, {
        id: "markdown:created",
        folderId: "folder-1",
        containerKind: "task" as const,
        containerId: "task-1",
        membershipKind: "primary" as const,
        sourceTaskItemId: null,
        itemType: "markdown" as const,
        itemId: "created",
        x: 20,
        y: 20,
        metadata: { title: "Created in task" },
      }, {
        id: "markdown:moved",
        folderId: "folder-1",
        containerKind: "task" as const,
        containerId: "task-1",
        membershipKind: "primary" as const,
        itemType: "markdown" as const,
        itemId: "moved",
        x: 40,
        y: 40,
        metadata: { title: "Moved into task" },
      }],
      markdownDocuments: [{
        id: "created",
        title: "Created in task",
        body: "Created body",
        version: 1,
      }, {
        id: "moved",
        title: "Moved into task",
        body: "Moved body",
        version: 1,
      }],
    };

    await expect(repository.syncBoardYjsReplica({
      folderId: "folder-1",
      containerKind: "task",
      containerId: "task-1",
    }, replica)).resolves.toBeUndefined();

    const sourceLookup = calls.find((call) => call.query.includes("FROM task_items"));
    expect(sourceLookup?.query).toContain("FOR KEY SHARE");
    expect(sourceLookup?.values).toEqual([[
      danglingSourceTaskItemId,
      existingSourceTaskItemId,
    ]]);
    const poisonedInsert = calls.find((call) =>
      call.query.includes("INSERT INTO board_items") && call.values[0] === "session:poisoned"
    );
    expect(poisonedInsert?.values[5]).toBeNull();
    const validInsert = calls.find((call) =>
      call.query.includes("INSERT INTO board_items") && call.values[0] === "session:valid"
    );
    expect(validInsert?.values[5]).toBe(existingSourceTaskItemId);
    const cachedBoardItems = jsonValues.find(Array.isArray) as typeof replica.boardItems;
    expect(cachedBoardItems).toEqual([
      expect.objectContaining({ id: "session:poisoned", sourceTaskItemId: null }),
      expect.objectContaining({
        id: "session:valid",
        sourceTaskItemId: existingSourceTaskItemId,
      }),
      expect.objectContaining({ id: "markdown:created" }),
      expect.objectContaining({ id: "markdown:moved" }),
    ]);
    const normalizedYdocReplica = normalizeMissingSourceTaskItemReferences(
      replica,
      new Set([existingSourceTaskItemId]),
    );
    expect(() => assertBoardItemProjectionParity({
      label: "board:task:task-1",
      ydocItems: normalizedYdocReplica.boardItems,
      projectionItems: cachedBoardItems,
    })).not.toThrow();
  });

  it("does not let a never-synced empty Y.Doc erase relational board_items", async () => {
    const { sql, calls } = createMockSql((call) =>
      call.query.includes("synced_at IS NOT NULL") ? [{ synced: false }] : [],
    );
    const resolver = { resolveSql: vi.fn(async () => sql), close: vi.fn() };
    const repository = new BoardYjsRepository(resolver);

    await repository.syncBoardYjsReplica(
      { folderId: "folder-1", containerKind: "folder", containerId: "folder-1" },
      { boardItems: [], markdownDocuments: [] },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("synced_at IS NOT NULL");
    expect(calls.some((call) => call.query.includes("DELETE FROM board_items"))).toBe(false);
  });

  it("loads a container seed through the shared board procedures", async () => {
    const { sql, calls } = createMockSql((call) => {
      if (call.query.includes("board_item_get_all")) {
        return [{
          id: "markdown:d1",
          folder_id: "folder-1",
          container_kind: "task",
          container_id: "rb-1",
          membership_kind: "primary",
          source_task_item_id: null,
          item_type: "markdown",
          item_id: "d1",
          x: 10,
          y: 20,
          metadata: { title: "Note" },
          created_at: null,
          updated_at: null,
        }];
      }
      if (call.query.includes("FROM markdown_documents")) {
        return [{
          id: "d1",
          title: "Note",
          body: "Body",
          version: 2,
          created_at: null,
          updated_at: null,
        }];
      }
      return [];
    });
    const repository = new BoardYjsRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    const seed = await repository.loadBoardYjsSeed({
      folderId: "folder-1",
      containerKind: "task",
      containerId: "rb-1",
    });

    expect(calls.map((call) => call.query)).toEqual([
      expect.stringContaining("board_seed_items"),
      expect.stringContaining("board_item_get_all"),
      expect.stringContaining("FROM markdown_documents"),
    ]);
    expect(seed).toEqual({
      boardItems: [expect.objectContaining({
        id: "markdown:d1",
        containerKind: "task",
        containerId: "rb-1",
      })],
      markdownDocuments: [{ id: "d1", title: "Note", body: "Body", version: 2 }],
    });
  });

  it("backfills a DB-only task tile into the folder snapshot and reconciles it", async () => {
    const { sql, calls } = createMockSql((call) => {
      if (call.query.includes("FROM board_items") && call.query.includes("item_type = 'task'")) {
        return [{
          id: "task:rb-1",
          folder_id: "folder-1",
          container_kind: "folder",
          container_id: "folder-1",
          membership_kind: "primary",
          source_task_item_id: null,
          item_type: "task",
          item_id: "rb-1",
          x: 40,
          y: 80,
          metadata: { title: "Task" },
          created_at: null,
          updated_at: null,
        }];
      }
      return [];
    });
    const repository = new BoardYjsRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });
    const empty = createBoardYDocSnapshot({
      folderId: "folder-1",
      boardItems: [],
      markdownDocuments: [],
    });

    const repaired = await repository.backfillTaskBoardItemsIntoSnapshot(
      "board-folder:folder-1",
      { folderId: "folder-1", containerKind: "folder", containerId: "folder-1" },
      empty,
    );
    const doc = new Y.Doc();
    Y.applyUpdate(doc, repaired);

    expect(readBoardYDocReplica("folder-1", doc).boardItems)
      .toEqual([expect.objectContaining({ id: "task:rb-1", itemType: "task" })]);
    expect(calls.some((call) => call.query.includes("INSERT INTO board_yjs_documents")))
      .toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO board_yjs_catalog_cache")))
      .toBe(true);
  });
});
