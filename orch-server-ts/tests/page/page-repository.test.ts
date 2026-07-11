import { describe, expect, it, vi } from "vitest";

import type { LivePostgresSql } from "../../src/runtime/live_db_sql.js";
import { PageRepository } from "../../src/page/page_repository.js";

interface SqlCall {
  query: string;
  values: unknown[];
  inTransaction: boolean;
}

function createMockSql(resultFor?: (call: SqlCall) => readonly Record<string, unknown>[]) {
  const calls: SqlCall[] = [];
  let inTransaction = false;
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { query: Array.from(strings).join("?"), values, inTransaction };
      calls.push(call);
      return Promise.resolve(resultFor?.(call) ?? []);
    },
    {
      json: (value: unknown) => value,
      array: (values: readonly unknown[]) => values,
      begin: async <T>(callback: (transaction: LivePostgresSql) => Promise<T>) => {
        inTransaction = true;
        try {
          return await callback(sql as unknown as LivePostgresSql);
        } finally {
          inTransaction = false;
        }
      },
    },
  ) as unknown as LivePostgresSql;
  return { sql, calls };
}

const replica = {
  page: {
    id: "page-1",
    title: "Page",
    dailyDate: null,
    mutationVersion: 2,
    archived: false,
    metadata: { color: "blue" },
  },
  blocks: [
    {
      id: "root",
      parentId: null,
      positionKey: "a",
      type: "paragraph",
      text: "Root",
      textDelta: [{ insert: "Root" }],
      properties: {},
      collapsed: false,
    },
    {
      id: "child",
      parentId: "root",
      positionKey: "b",
      type: "checklist",
      text: "Child",
      textDelta: [{ insert: "Child" }],
      properties: { checked: true },
      collapsed: true,
    },
  ],
};

describe("orch PageRepository", () => {
  it("stores snapshot, update, page, block SET-DIFF, and link diff in one transaction", async () => {
    const { sql, calls } = createMockSql();
    const repository = new PageRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });
    const snapshot = new Uint8Array([1, 2]);
    const update = new Uint8Array([3, 4]);

    await repository.storePageYjsState({
      documentName: "page:page-1",
      snapshot,
      update,
      replica,
    });

    expect(calls.map((call) => call.query)).toEqual([
      expect.stringContaining("INSERT INTO board_yjs_documents"),
      expect.stringContaining("INSERT INTO board_yjs_updates"),
      expect.stringContaining("INSERT INTO pages"),
      expect.stringContaining("DELETE FROM blocks"),
      expect.stringContaining("INSERT INTO blocks"),
      expect.stringContaining("INSERT INTO blocks"),
      expect.stringContaining("SELECT source_block_id"),
      expect.stringContaining("DELETE FROM block_links"),
      expect.stringContaining("UPDATE block_links"),
    ]);
    expect(calls.every((call) => call.inTransaction)).toBe(true);
    expect(calls[0]?.values[0]).toBe("page:page-1");
    expect(calls.some((call) => call.query.includes("board_items"))).toBe(false);
    expect(calls.some((call) => call.query.includes("block_links"))).toBe(true);
  });

  it("reads bytes from the shared document table without board canonicalization", async () => {
    const { sql, calls } = createMockSql((call) =>
      call.query.includes("SELECT snapshot") ? [{ snapshot: new Uint8Array([7, 8]) }] : [],
    );
    const repository = new PageRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await expect(repository.getPageYjsSnapshot("page:page-1"))
      .resolves.toEqual(new Uint8Array([7, 8]));
    expect(calls[0]?.values).toEqual(["page:page-1"]);
  });

  it("rejects a replica whose document name and page id differ", async () => {
    const { sql, calls } = createMockSql();
    const repository = new PageRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await expect(repository.storePageYjsState({
      documentName: "page:other",
      snapshot: new Uint8Array([1]),
      replica,
    })).rejects.toThrow("page id");
    expect(calls).toHaveLength(0);
  });
});
