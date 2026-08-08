import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { BoardYjsMoveRepository } from
  "../src/board-yjs/board_yjs_move_repository.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";

interface SqlCall {
  query: string;
  values: unknown[];
  inTransaction: boolean;
}

describe("BoardYjsMoveRepository", () => {
  it("persists source and target replicas with the session folder assignment in one transaction", async () => {
    const { sql, calls } = createMockSql();
    const repository = new BoardYjsMoveRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await repository.commitSessionMove({
      sessionId: "session-a",
      folderId: "folder-target",
      boardApplications: ["folder-source", "folder-target"].map((containerId) => ({
        documentName: `board-folder:${containerId}`,
        scope: { folderId: containerId, containerKind: "folder" as const, containerId },
        snapshot: Y.encodeStateAsUpdate(new Y.Doc()),
        replica: { boardItems: [], markdownDocuments: [] },
      })),
    });

    const snapshotCalls = calls.filter((call) =>
      call.query.includes("INSERT INTO board_yjs_documents")
    );
    const assignment = calls.find((call) =>
      call.query.includes("SELECT session_assign_folder(")
    );
    expect(snapshotCalls).toHaveLength(2);
    expect(assignment?.values).toEqual(["session-a", "folder-target"]);
    expect(calls.every((call) => call.inTransaction)).toBe(true);
    expect(calls.indexOf(assignment!)).toBeGreaterThan(
      Math.max(...snapshotCalls.map((call) => calls.indexOf(call))),
    );
  });
});

function createMockSql() {
  const calls: SqlCall[] = [];
  let inTransaction = false;
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = Array.from(strings).join("?");
      calls.push({ query, values, inTransaction });
      return Promise.resolve(
        query.includes("INSERT INTO board_yjs_documents") &&
          query.includes("RETURNING revision")
          ? [{ revision: 1 }]
          : [],
      );
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
