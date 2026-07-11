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

  it("looks up normalized titles and daily dates through the page replica", async () => {
    const { sql, calls } = createMockSql((call) => {
      if (call.query.includes("title_key")) return [{ id: "page-title" }];
      if (call.query.includes("daily_date")) return [{ id: "page-daily" }];
      return [];
    });
    const repository = new PageRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await expect(repository.findPageIdByTitle("  PAGE  ")).resolves.toBe("page-title");
    await expect(repository.findPageIdByDailyDate("2026-07-12")).resolves.toBe("page-daily");
    expect(calls[0]?.query).toContain("lower(btrim");
    expect(calls[1]?.query).toContain("::date");
  });

  it("paginates backlinks with an opaque (created_at,id) cursor", async () => {
    const rows = [
      backlinkRow("link-1", new Date("2026-07-11T00:00:00.000Z")),
      backlinkRow("link-2", new Date("2026-07-11T00:00:01.000Z")),
    ];
    const { sql, calls } = createMockSql((call) =>
      call.query.includes("FROM block_links") ? rows : []);
    const repository = new PageRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    const first = await repository.getPageBacklinks({
      pageId: "target",
      kinds: ["mount"],
      limit: 1,
    });
    expect(first.items).toEqual([expect.objectContaining({ id: "link-1", source_page_id: "source" })]);
    expect(first.next_cursor).toEqual(expect.any(String));

    await repository.getPageBacklinks({
      pageId: "target",
      kinds: ["mount"],
      cursor: first.next_cursor!,
      limit: 1,
    });
    expect(calls[1]?.values).toContain("2026-07-11T00:00:00.000Z");
    expect(calls[1]?.values).toContain("link-1");
  });

  it("lists pages with a deterministic updated_at/id cursor and starred filter", async () => {
    const rows = [
      pageRow("page-3", new Date("2026-07-11T03:00:00.000Z"), true),
      pageRow("page-2", new Date("2026-07-11T02:00:00.000Z"), true),
      pageRow("page-1", new Date("2026-07-11T01:00:00.000Z"), true),
    ];
    const { sql, calls } = createMockSql((call) =>
      call.query.includes("FROM pages") && call.query.includes("ORDER BY updated_at DESC")
        ? rows
        : []);
    const repository = new PageRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    const first = await repository.listPages({ starred: true, limit: 2 });
    expect(first.items).toEqual([
      expect.objectContaining({ id: "page-3", metadata: { starred: true } }),
      expect.objectContaining({ id: "page-2", updated_at: "2026-07-11T02:00:00.000Z" }),
    ]);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(calls[0]?.query).toContain("metadata");
    expect(calls[0]?.query).toContain("id DESC");

    await repository.listPages({ starred: true, cursor: first.next_cursor!, limit: 2 });
    expect(calls[1]?.values).toContain("2026-07-11T02:00:00.000Z");
    expect(calls[1]?.values).toContain("page-2");
  });
});

function backlinkRow(id: string, createdAt: Date) {
  return {
    id,
    source_page_id: "source",
    source_block_id: "block-source",
    link_kind: "mount",
    target_page_id: "target",
    target_block_id: null,
    source_start: 0,
    source_end: 10,
    created_at: createdAt,
  };
}

function pageRow(id: string, updatedAt: Date, starred: boolean) {
  return {
    id,
    title: id,
    daily_date: null,
    version: 1,
    archived: false,
    metadata: { starred },
    created_at: new Date("2026-07-10T00:00:00.000Z"),
    updated_at: updatedAt,
  };
}
