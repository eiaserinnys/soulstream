import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { SessionDeletionRepository } from
  "../src/session/session_deletion_repository.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";

interface SqlCall {
  query: string;
  values: unknown[];
  inTransaction: boolean;
}

describe("SessionDeletionRepository", () => {
  it("enumerates projection and cache-only memberships before canonical sync and session_delete", async () => {
    const { sql, calls } = createMockSql((call) => {
      if (call.query.includes("FROM board_items") && call.query.includes("item_type = 'session'")) {
        return [boardItemRow("session:session-a", "folder", "folder-1", "primary")];
      }
      if (call.query.includes("FROM board_yjs_catalog_cache")) {
        return [{
          folder_id: "folder-1",
          container_kind: "folder",
          container_id: "folder-1",
          board_items: [cachedBoardItem(
            "session:session-a",
            "folder",
            "folder-1",
            "primary",
          )],
        }, {
          folder_id: "folder-1",
          container_kind: "task",
          container_id: "task-1",
          board_items: JSON.stringify([cachedBoardItem(
            "session-reference:session-a",
            "task",
            "task-1",
            "reference",
          )]),
        }];
      }
      if (call.query.includes("INSERT INTO board_yjs_documents") &&
        call.query.includes("RETURNING revision")) {
        return [{ revision: 1 }];
      }
      return [];
    });
    const repository = new SessionDeletionRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    const boardItems = await repository.listSessionBoardItems("session-a");
    await repository.deleteSession({
      sessionId: "session-a",
      boardApplications: [{
        documentName: "board-folder:folder-1",
        scope: {
          folderId: "folder-1",
          containerKind: "folder",
          containerId: "folder-1",
        },
        snapshot: Y.encodeStateAsUpdate(new Y.Doc()),
        replica: { boardItems: [], markdownDocuments: [] },
      }],
    });

    expect(boardItems.map((item) => [item.id, item.membershipKind])).toEqual([
      ["session:session-a", "primary"],
      ["session-reference:session-a", "reference"],
    ]);
    const snapshotIndex = calls.findIndex((call) =>
      call.query.includes("INSERT INTO board_yjs_documents")
    );
    const projectionIndex = calls.findIndex((call) =>
      call.query.includes("DELETE FROM board_items")
    );
    const cacheIndex = calls.findIndex((call) =>
      call.query.includes("INSERT INTO board_yjs_catalog_cache")
    );
    const sessionDeleteIndex = calls.findIndex((call) =>
      call.query.includes("SELECT session_delete(")
    );
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(projectionIndex).toBeGreaterThan(snapshotIndex);
    expect(cacheIndex).toBeGreaterThan(projectionIndex);
    expect(sessionDeleteIndex).toBeGreaterThan(cacheIndex);
    expect(calls.slice(snapshotIndex).every((call) => call.inTransaction)).toBe(true);
    expect(calls[sessionDeleteIndex]?.values).toEqual(["session-a"]);
  });
});

function cachedBoardItem(
  id: string,
  containerKind: "folder" | "task",
  containerId: string,
  membershipKind: "primary" | "reference",
) {
  return {
    id,
    folderId: "folder-1",
    containerKind,
    containerId,
    membershipKind,
    sourceTaskItemId: null,
    itemType: "session",
    itemId: "session-a",
    x: 0,
    y: 0,
    metadata: {},
  };
}

function boardItemRow(
  id: string,
  containerKind: "folder" | "task",
  containerId: string,
  membershipKind: "primary" | "reference",
) {
  return {
    id,
    folder_id: "folder-1",
    container_kind: containerKind,
    container_id: containerId,
    membership_kind: membershipKind,
    source_task_item_id: null,
    item_type: "session" as const,
    item_id: "session-a",
    x: 0,
    y: 0,
    metadata: {},
    created_at: null,
    updated_at: null,
  };
}

function createMockSql(
  resultFor: (call: SqlCall) => readonly Record<string, unknown>[],
) {
  const calls: SqlCall[] = [];
  let inTransaction = false;
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { query: Array.from(strings).join("?"), values, inTransaction };
      calls.push(call);
      return Promise.resolve(resultFor(call));
    },
    {
      array: (values: readonly unknown[]) => values,
      json: (value: unknown) => value,
      begin: async <T>(callback: (transaction: LivePostgresSql) => Promise<T>) => {
        inTransaction = true;
        try {
          const transaction = Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => sql(strings, ...values),
            {
              array: (values: readonly unknown[]) => values,
              json: (value: unknown) => value,
            },
          ) as unknown as LivePostgresSql;
          return await callback(transaction);
        } finally {
          inTransaction = false;
        }
      },
    },
  ) as unknown as LivePostgresSql;
  return { sql, calls };
}
