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
      expect.stringContaining("INSERT INTO checklist_runbook_projection_outbox"),
      expect.stringContaining("UPDATE checklist_runbook_projection_outbox"),
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

  it("checks the SQL page projection independently from the Y.Doc snapshot", async () => {
    const { sql, calls } = createMockSql((call) =>
      call.query.includes("SELECT EXISTS") ? [{ exists: true }] : [],
    );
    const repository = new PageRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await expect(repository.hasPageProjection("page-1")).resolves.toBe(true);
    expect(calls).toEqual([expect.objectContaining({
      query: expect.stringContaining("FROM pages"),
      values: ["page-1"],
    })]);
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
    expect(calls[0]?.query).toContain("source.page_id <> ?");
    expect(calls[0]?.values).toContain(false);

    await repository.getPageBacklinks({
      pageId: "target",
      kinds: ["mount"],
      includeSelf: true,
      limit: 1,
    });
    expect(calls[2]?.values).toContain(true);
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

  it("uses literal prefix queries with deterministic title/text and id ordering", async () => {
    const { sql, calls } = createMockSql((call) => {
      if (call.query.includes("FROM pages") && call.query.includes("title_key LIKE")) {
        return [{ page_id: "page-1", title: "Page" }];
      }
      if (call.query.includes("FROM blocks block") && call.query.includes("text_plain")) {
        return [{
          block_id: "block-1",
          page_id: "page-1",
          page_title: "Page",
          text_plain: "Block text",
        }];
      }
      return [];
    });
    const repository = new PageRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await expect(repository.searchBrowserPages({ query: "100%_", limit: 5 })).resolves.toEqual({
      items: [{ pageId: "page-1", title: "Page" }],
    });
    await expect(repository.searchBrowserBlocks({ query: "Block", limit: 6 })).resolves.toEqual({
      items: [{
        blockId: "block-1",
        pageId: "page-1",
        pageTitle: "Page",
        textPreview: "Block text",
      }],
    });
    expect(calls[0]?.query).toContain("title_key LIKE");
    expect(calls[0]?.query).toContain("ORDER BY title_key ASC, id ASC");
    expect(calls[0]?.values).toContain("100\\%\\_");
    expect(calls[1]?.query).toContain("ORDER BY lower(block.text_plain) ASC, block.id ASC");
  });

  it("reads a single browser block and returns null when it is deleted", async () => {
    const rows = [{
      id: "block-1",
      page_id: "page-1",
      page_title: "Page",
      parent_id: null,
      position_key: "a",
      block_type: "paragraph",
      text_plain: "Block",
      properties: {},
      collapsed: false,
    }];
    let read = 0;
    const { sql } = createMockSql((call) =>
      call.query.includes("WHERE block.id") && read++ === 0 ? rows : []);
    const repository = new PageRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await expect(repository.getBrowserBlock("block-1")).resolves.toEqual({
      id: "block-1",
      pageId: "page-1",
      pageTitle: "Page",
      parentId: null,
      positionKey: "a",
      blockType: "paragraph",
      text: "Block",
      properties: {},
      collapsed: false,
    });
    await expect(repository.getBrowserBlock("deleted")).resolves.toBeNull();
  });

  it("paginates browser backlinks with source previews, nullable targets, and kind-bound cursors", async () => {
    const createdAt = new Date("2026-07-11T00:00:00.000Z");
    const rows = [
      browserBacklinkRow("link-1", createdAt, "First   source"),
      browserBacklinkRow("link-2", createdAt, "Second source", null),
    ];
    const { sql, calls } = createMockSql((call) =>
      call.query.includes("source_page_title") ? rows : []);
    const repository = new PageRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    const first = await repository.getBrowserBacklinks({
      pageId: "target",
      kinds: ["mount", "inline_page"],
      limit: 1,
    });
    expect(first).toEqual({
      items: [expect.objectContaining({
        id: "link-1",
        sourcePageTitle: "Source Page",
        sourceTextPreview: "First source",
        linkKind: "mount",
      })],
      nextCursor: expect.any(String),
    });

    await repository.getBrowserBacklinks({
      pageId: "target",
      kinds: ["inline_page", "mount"],
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect(calls[1]?.query).toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'");
    expect(calls[1]?.query).toContain(") > (?::text, ?)");
    expect(calls[1]?.values).toContain("link-1");
    expect(calls[0]?.query).toContain("source.page_id <> ?");
    expect(calls[0]?.values).toContain(false);

    const withSelf = await repository.getBrowserBacklinks({
      pageId: "target",
      kinds: ["mount", "inline_page"],
      includeSelf: true,
      limit: 1,
    });
    expect(calls[2]?.values).toContain(true);
    expect(withSelf.nextCursor).toEqual(expect.any(String));

    await expect(repository.getBrowserBacklinks({
      pageId: "target",
      kinds: ["mount", "inline_page"],
      cursor: withSelf.nextCursor!,
      includeSelf: false,
      limit: 1,
    })).rejects.toMatchObject({ code: "PAGE_BROWSER_BACKLINK_CURSOR_INVALID" });

    await expect(repository.getBrowserBacklinks({
      pageId: "target",
      kinds: ["block_ref"],
      cursor: first.nextCursor!,
      limit: 1,
    })).rejects.toMatchObject({ code: "PAGE_BROWSER_BACKLINK_CURSOR_INVALID" });
    await expect(repository.getBrowserBacklinks({
      pageId: "different-target",
      kinds: ["mount", "inline_page"],
      cursor: first.nextCursor!,
      limit: 1,
    })).rejects.toMatchObject({ code: "PAGE_BROWSER_BACKLINK_CURSOR_INVALID" });
  });

  it("resolves the nearest session defaults through reverse mount and physical ancestors", async () => {
    const { sql, calls } = createMockSql((call) => {
      if (call.query.includes("WITH RECURSIVE ancestors")) {
        return [{
          id: "defaults-parent",
          page_id: "project-page",
          position_key: "a",
          properties: { scope: "run", agentId: "roselin", nodeId: "node-a" },
        }];
      }
      if (call.query.includes("SELECT source.page_id")) {
        return call.values.includes("work-page")
          ? [{ page_id: "project-page", block_id: "mount-work", position_key: "b" }]
          : [];
      }
      return [];
    });
    const repository = new PageRepository({
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(),
    });

    await expect(repository.resolvePageSessionDefaults("work-page")).resolves.toEqual({
      agentId: "roselin",
      nodeId: "node-a",
      sourcePageId: "project-page",
      sourceBlockId: "defaults-parent",
    });
    expect(calls.map((call) => call.query)).toEqual([
      expect.stringContaining("block_type = 'session_defaults'"),
      expect.stringContaining("link.link_kind = 'mount'"),
      expect.stringContaining("WITH RECURSIVE ancestors"),
    ]);
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

function browserBacklinkRow(
  id: string,
  createdAt: Date,
  text: string,
  targetPageId: string | null = "target",
) {
  return {
    id,
    source_page_id: "source",
    source_page_title: "Source Page",
    source_block_id: "block-source",
    source_text_plain: text,
    link_kind: "mount",
    target_page_id: targetPageId,
    target_block_id: null,
    source_start: 0,
    source_end: 10,
    created_at_cursor: createdAt.toISOString().replace("Z", "000Z"),
  };
}
