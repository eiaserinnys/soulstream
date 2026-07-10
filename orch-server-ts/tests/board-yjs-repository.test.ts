import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { createBoardYDocSnapshot, readBoardYDocReplica } from "../src/board-yjs/board_yjs_model.js";
import { BoardYjsRepository } from "../src/board-yjs/board_yjs_repository.js";
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
      containerKind: "runbook" as const,
      containerId: "rb-1",
    };
    const doc = new Y.Doc();
    Y.applyUpdate(doc, createBoardYDocSnapshot({
      ...scope,
      boardItems: [{
        id: "markdown:d1",
        folderId: "folder-1",
        containerKind: "runbook",
        containerId: "rb-1",
        membershipKind: "primary",
        sourceRunbookItemId: null,
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
          container_kind: "runbook",
          container_id: "rb-1",
          membership_kind: "primary",
          source_runbook_item_id: null,
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
      containerKind: "runbook",
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
        containerKind: "runbook",
        containerId: "rb-1",
      })],
      markdownDocuments: [{ id: "d1", title: "Note", body: "Body", version: 2 }],
    });
  });

  it("backfills a DB-only runbook tile into the folder snapshot and reconciles it", async () => {
    const { sql, calls } = createMockSql((call) => {
      if (call.query.includes("FROM board_items") && call.query.includes("item_type = 'runbook'")) {
        return [{
          id: "runbook:rb-1",
          folder_id: "folder-1",
          container_kind: "folder",
          container_id: "folder-1",
          membership_kind: "primary",
          source_runbook_item_id: null,
          item_type: "runbook",
          item_id: "rb-1",
          x: 40,
          y: 80,
          metadata: { title: "Runbook" },
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

    const repaired = await repository.backfillRunbookBoardItemsIntoSnapshot(
      "board-folder:folder-1",
      { folderId: "folder-1", containerKind: "folder", containerId: "folder-1" },
      empty,
    );
    const doc = new Y.Doc();
    Y.applyUpdate(doc, repaired);

    expect(readBoardYDocReplica("folder-1", doc).boardItems)
      .toEqual([expect.objectContaining({ id: "runbook:rb-1", itemType: "runbook" })]);
    expect(calls.some((call) => call.query.includes("INSERT INTO board_yjs_documents")))
      .toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO board_yjs_catalog_cache")))
      .toBe(true);
  });
});
