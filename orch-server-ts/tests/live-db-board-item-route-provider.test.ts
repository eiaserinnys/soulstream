import { describe, expect, it, vi } from "vitest";

import {
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  text: string;
  values: unknown[];
};

describe("live DB board item route provider", () => {
  it("looks up one board item by id without reading the whole catalog", async () => {
    const harness = createSqlHarness(text => text.includes("FROM board_items bi")
      ? [boardItemRow({ id: "item-target", item_type: "asset", x: "12", y: "34" })] : []);
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });
    await expect(repository.boardItemRouteProvider.getBoardItemById("item-target"))
      .resolves.toMatchObject({ id: "item-target", folderId: "folder-a", itemType: "asset", x: 12, y: 34 });
    expect(harness.calls).toHaveLength(1);
    expect(harness.normalizedCalls()[0]).toContain("WHERE bi.id = ?");
    expect(harness.calls[0]?.values).toEqual(["item-target"]);
  });

  it("lists folder documents through the flat SQL projection", async () => {
    const harness = createSqlHarness(text => {
      if (text.includes("folder_get_all")) return [folderRow()];
      if (text.includes("WITH flat_items")) return [{
        bi_id: "item-markdown", bi_folder_id: "folder-a", bi_membership_kind: "primary",
        bi_item_type: "markdown", bi_item_id: "doc-1", bi_x: 20, bi_y: 40,
        bi_metadata: { title: "Doc" }, bi_created_at: new Date("2026-07-09T01:00:00.000Z"),
        bi_updated_at: new Date("2026-07-09T00:00:00.000Z"),
        markdown_id: "doc-1", markdown_title: "Doc", markdown_body: "Body", total_count: 1,
      }];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });
    await expect(repository.boardItemRouteProvider.listFolders()).resolves.toEqual([
      expect.objectContaining({ id: "folder-a", parentFolderId: null }),
    ]);
    await expect(repository.boardItemRouteProvider.listBoardItems({ folderId: "folder-a" }))
      .resolves.toEqual([expect.objectContaining({ id: "item-markdown", folderId: "folder-a",
        itemType: "markdown", itemId: "doc-1", metadata: { title: "Doc" }, x: 20, y: 40,
        createdAt: "2026-07-09T01:00:00.000Z", updatedAt: "2026-07-09T00:00:00.000Z" })]);
    const query = harness.normalizedCalls()[1]!;
    expect(query).toContain("FROM markdown_documents md");
    expect(query).toContain("FROM board_items b");
    expect(query).toContain("FROM sessions s");
    expect(query).not.toContain("board_yjs_catalog_cache");
    expect(harness.calls[1]?.values).toContain("folder-a");
  });

  it("lists concrete folder items with SQL row aliases", async () => {
    const harness = createSqlHarness(text => text.includes("WITH flat_items") ? [{
      bi_id: "session:sess-1", bi_folder_id: "task-1", bi_membership_kind: "primary",
      bi_item_type: "session", bi_item_id: "sess-1", bi_x: 0, bi_y: 0, bi_metadata: {},
      bi_created_at: new Date("2026-07-09T02:00:00.000Z"),
      bi_updated_at: new Date("2026-07-09T02:01:00.000Z"), total_count: 1,
    }] : []);
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });
    await expect(repository.boardItemRouteProvider.listBoardItems({ folderId: "task-1" }))
      .resolves.toEqual([expect.objectContaining({ id: "session:sess-1", folderId: "task-1",
        membershipKind: "primary", itemType: "session", itemId: "sess-1", x: 0, y: 0 })]);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.values).toContain("task-1");
  });

  it("looks up a session's canonical membership without folder pagination", async () => {
    const harness = createSqlHarness(text => text.includes("FROM sessions WHERE session_id")
      ? [boardItemRow({ id: "session:session-a", folder_id: "task-outside-page",
        item_id: "session-a", x: 0, y: 0 })] : []);
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });
    await expect(repository.boardItemRouteProvider.listBoardItems({ sessionId: "session-a" }))
      .resolves.toEqual([expect.objectContaining({ id: "session:session-a", itemId: "session-a",
        membershipKind: "primary", folderId: "task-outside-page", x: 0, y: 0 })]);
    expect(harness.normalizedCalls()).toEqual([
      expect.stringContaining("FROM sessions WHERE session_id = ? AND folder_id IS NOT NULL"),
    ]);
    expect(harness.calls[0]?.values).toEqual(["session-a"]);
  });
});

function folderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "folder-a",
    name: "Folder",
    sort_order: 1,
    parent_folder_id: null,
    settings: {},
    created_at: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

function boardItemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-a",
    folder_id: "folder-a",
    membership_kind: "primary",
    item_type: "session",
    item_id: "sess-1",
    x: 20,
    y: 40,
    metadata: {},
    created_at: new Date("2026-07-09T00:00:00.000Z"),
    updated_at: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

function createSqlHarness(
  rowsFor: (text: string, values: unknown[]) => readonly Record<string, unknown>[] = () => [],
) {
  const calls: SqlCall[] = [];
  const sqlCall = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return rowsFor(text, values);
  });
  const sql = Object.assign(sqlCall, {
    json: (value: unknown) => value,
    array: (values: readonly unknown[]) => values,
    begin: async <T>(callback: (transaction: LivePostgresSql) => Promise<T>) =>
      await callback(sqlCall as unknown as LivePostgresSql),
  }) as unknown as LivePostgresSql;

  return {
    sql,
    calls,
    normalizedCalls: () =>
      calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}
