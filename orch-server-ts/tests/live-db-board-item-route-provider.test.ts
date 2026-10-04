import { describe, expect, it, vi } from "vitest";

import {
  BoardItemRouteError,
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  text: string;
  values: unknown[];
};

describe("live DB board item route provider", () => {
  it("looks up one board item by id without reading the whole catalog", async () => {
    const harness = createSqlHarness((text) => text.includes("FROM board_items")
      ? [boardItemRow({ id: "item-target", x: "12", y: "34" })]
      : []);
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(repository.boardItemRouteProvider.getBoardItemById("item-target"))
      .resolves.toEqual({
        id: "item-target",
        folderId: "folder-a",
        membershipKind: "primary",
        itemType: "session",
        itemId: "sess-1",
        x: 12,
        y: 34,
        metadata: {},
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      });
    expect(harness.normalizedCalls()).toEqual([
      "SELECT * FROM board_items WHERE id = ? LIMIT 1",
    ]);
    expect(harness.calls[0]?.values).toEqual(["item-target"]);
  });

  it("lists folder-scoped primary board items with Python catalog serialization", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("folder_get_all")) return [folderRow()];
      if (text.includes("board_item_get_all")) {
        return [
          boardItemRow({
            id: "item-markdown",
            item_type: "markdown",
            item_id: "doc-1",
            metadata: { title: "Doc" },
            created_at: new Date("2026-07-09T01:00:00.000Z"),
          }),
        ];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(repository.boardItemRouteProvider.listFolders()).resolves.toEqual([
      expect.objectContaining({ id: "folder-a", parentFolderId: null }),
    ]);
    await expect(
      repository.boardItemRouteProvider.listBoardItems({ folderId: "folder-a" }),
    ).resolves.toEqual([
      {
        id: "item-markdown",


        folderId: "folder-a",
        membershipKind: "primary",
        itemType: "markdown",
        itemId: "doc-1",
        x: 20,
        y: 40,
        metadata: { title: "Doc" },
        createdAt: "2026-07-09T01:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      },
    ]);
    expect(harness.normalizedCalls()).toEqual([
      "SELECT * FROM folder_get_all()",
      expect.stringContaining("WHERE folder_id = ? AND membership_kind = 'primary'"),
    ]);
    expect(harness.calls.at(-1)?.values).toEqual(["folder-a"]);
  });

  it("lists concrete container board items from the folder projection", async () => {
    const cached = {
      id: "item-section",


      folderId: "task-1",
      membershipKind: "primary",
      itemType: "session",
      itemId: "sess-1",
      x: 10,
      y: 30,
      metadata: { title: "Session" },
      createdAt: "2026-07-09T02:00:00.000Z",
      updatedAt: "2026-07-09T02:01:00.000Z",
    };
    const harness = createSqlHarness((text) => {
      if (text.includes("board_item_get_all")) {
        return [cached];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.boardItemRouteProvider.listBoardItems({
        folderId: "task-1",
      }),
    ).resolves.toEqual([cached]);
    expect(harness.normalizedCalls()).toEqual([
      expect.stringContaining(
        "FROM board_item_get_all() WHERE folder_id = ?",
      ),
    ]);
    expect(harness.calls[0]?.values).toEqual(["task-1"]);
  });

  it("looks up a session's canonical primary membership without folder pagination", async () => {
    const harness = createSqlHarness((text) => text.includes("board_item_get_all")
      ? [boardItemRow({
          id: "session:session-a",
          folder_id: "task-outside-page",
          item_type: "session",
          item_id: "session-a",
        })]
      : []);
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(repository.boardItemRouteProvider.listBoardItems({
      sessionId: "session-a",
    })).resolves.toEqual([
      expect.objectContaining({
        itemId: "session-a",
        membershipKind: "primary",

        folderId: "task-outside-page",
      }),
    ]);
    expect(harness.normalizedCalls()).toEqual([
      expect.stringContaining("WHERE item_type = 'session' AND item_id = ? AND membership_kind = 'primary'"),
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
