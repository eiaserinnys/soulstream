import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createBoardYDocSnapshot, readBoardYDocReplica } from "../src/board-yjs/board_yjs_model.js";
import { BoardYjsRepository } from "../src/board-yjs/board_yjs_repository.js";
import { assertBoardItemProjectionParity } from
  "../src/board-yjs/board_yjs_projection_verification.js";
import { normalizeMissingSourceChecklistItemReferences } from
  "../src/board-yjs/board_yjs_replica_normalization.js";
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

      };
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createBoardYDocSnapshot({
      ...scope,
      boardItems: [{
        id: "markdown:d1",
        folderId: "folder-1",
        membershipKind: "primary",
        sourceChecklistItemId: null,
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
    const danglingSourceChecklistItemId = "missing-task-item";
    const existingSourceChecklistItemId = "existing-task-item";
    const { sql, calls, jsonValues } = createMockSql((call) => {
      if (call.query.includes("FROM checklist_items")) return [{ id: existingSourceChecklistItemId }];
      if (
        call.query.includes("INSERT INTO board_items") &&
        call.values[3] === danglingSourceChecklistItemId
      ) {
        throw new Error(
          'violates foreign key constraint "board_items_source_checklist_item_id_fkey"',
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

        membershipKind: "primary" as const,
        sourceChecklistItemId: danglingSourceChecklistItemId,
        itemType: "session" as const,
        itemId: "poisoned",
        x: 0,
        y: 0,
        metadata: {},
      }, {
        id: "session:valid",
        folderId: "folder-1",

        membershipKind: "primary" as const,
        sourceChecklistItemId: existingSourceChecklistItemId,
        itemType: "session" as const,
        itemId: "valid",
        x: 10,
        y: 10,
        metadata: {},
      }, {
        id: "markdown:created",
        folderId: "folder-1",

        membershipKind: "primary" as const,
        sourceChecklistItemId: null,
        itemType: "markdown" as const,
        itemId: "created",
        x: 20,
        y: 20,
        metadata: { title: "Created in task" },
      }, {
        id: "markdown:moved",
        folderId: "folder-1",

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
      }, replica)).resolves.toBeUndefined();

    const sourceLookup = calls.find((call) => call.query.includes("FROM checklist_items"));
    expect(sourceLookup?.query).toContain("FOR KEY SHARE");
    expect(sourceLookup?.values).toEqual([[
      danglingSourceChecklistItemId,
      existingSourceChecklistItemId,
    ]]);
    const poisonedInsert = calls.find((call) =>
      call.query.includes("INSERT INTO board_items") && call.values[0] === "session:poisoned"
    );
    expect(poisonedInsert?.values[3]).toBeNull();
    const validInsert = calls.find((call) =>
      call.query.includes("INSERT INTO board_items") && call.values[0] === "session:valid"
    );
    expect(validInsert?.values[3]).toBe(existingSourceChecklistItemId);
    const cachedBoardItems = jsonValues.find(Array.isArray) as typeof replica.boardItems;
    expect(cachedBoardItems).toEqual([
      expect.objectContaining({ id: "session:poisoned", sourceChecklistItemId: null }),
      expect.objectContaining({
        id: "session:valid",
        sourceChecklistItemId: existingSourceChecklistItemId,
      }),
      expect.objectContaining({ id: "markdown:created" }),
      expect.objectContaining({ id: "markdown:moved" }),
    ]);
    const normalizedYdocReplica = normalizeMissingSourceChecklistItemReferences(
      replica,
      new Set([existingSourceChecklistItemId]),
    );
    expect(() => assertBoardItemProjectionParity({
      label: "board-folder:task-1",
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
      {  folderId: "folder-1" },
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
          membership_kind: "primary",
          source_checklist_item_id: null,
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
      });

    expect(calls.map((call) => call.query)).toEqual([
      expect.stringContaining("board_seed_items"),
      expect.stringContaining("board_item_get_all"),
      expect.stringContaining("FROM markdown_documents"),
    ]);
    expect(calls[0]?.values).toEqual(["folder-1"]);
    expect(calls[1]).toMatchObject({
      values: ["folder-1"],
    });
    expect(calls[1]?.query).toContain("WHERE folder_id =");
    expect(seed).toEqual({
      boardItems: [expect.objectContaining({
        id: "markdown:d1",
        })],
      markdownDocuments: [{ id: "d1", title: "Note", body: "Body", version: 2 }],
    });
  });


});
