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
        containerKind: "folder",
        containerId: "folder-a",
        membershipKind: "primary",
        sourceTaskItemId: null,
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

  it("lists concrete container board items from the Y.Doc catalog cache", async () => {
    const cached = {
      id: "item-section",
      folderId: "folder-a",
      containerKind: "task",
      containerId: "task-1",
      membershipKind: "primary",
      sourceTaskItemId: "section-1",
      itemType: "session",
      itemId: "sess-1",
      x: 10,
      y: 30,
      metadata: { title: "Session" },
      createdAt: "2026-07-09T02:00:00.000Z",
      updatedAt: "2026-07-09T02:01:00.000Z",
    };
    const harness = createSqlHarness((text) => {
      if (text.includes("board_yjs_catalog_cache")) {
        return [{ board_items: JSON.stringify([cached]) }];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.boardItemRouteProvider.listBoardItems({
        container: { kind: "task", id: "task-1" },
      }),
    ).resolves.toEqual([cached]);
    expect(harness.normalizedCalls()).toEqual([
      expect.stringContaining(
        "FROM board_yjs_catalog_cache WHERE container_kind = ? AND container_id = ?",
      ),
    ]);
    expect(harness.calls[0]?.values).toEqual(["task", "task-1"]);
  });

  it("looks up a session's canonical primary membership without folder pagination", async () => {
    const harness = createSqlHarness((text) => text.includes("board_item_get_all")
      ? [boardItemRow({
          id: "session:session-a",
          container_kind: "task",
          container_id: "task-outside-page",
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
        containerKind: "task",
        containerId: "task-outside-page",
      }),
    ]);
    expect(harness.normalizedCalls()).toEqual([
      expect.stringContaining("WHERE item_type = 'session' AND item_id = ? AND membership_kind = 'primary'"),
    ]);
    expect(harness.calls[0]?.values).toEqual(["session-a"]);
  });

  it("resolves cached tasks first and new empty tasks through canonical identity", async () => {
    let cacheCalls = 0;
    const harness = createSqlHarness((text, values) => {
      if (text.includes("folder_get_all")) return [folderRow()];
      if (text.includes("board_yjs_catalog_cache")) {
        cacheCalls += 1;
        return cacheCalls === 1 ? [{ folder_id: "folder-a" }] : [];
      }
      if (text.includes("FROM tasks task")) {
        return values[0] === "task-new" ? [{ folder_id: "folder-new" }] : [];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.boardItemRouteProvider.resolveBoardContainerFolderId({
        kind: "folder",
        id: "folder-direct",
      }),
    ).resolves.toBe("folder-direct");
    await expect(
      repository.boardItemRouteProvider.resolveBoardContainerFolderId({
        kind: "task",
        id: "task-1",
      }),
    ).resolves.toBe("folder-a");
    await expect(
      repository.boardItemRouteProvider.resolveBoardContainerFolderId({
        kind: "task",
        id: "task-new",
      }),
    ).resolves.toBe("folder-new");
    await expect(
      repository.boardItemRouteProvider.resolveBoardContainerFolderId({
        kind: "task",
        id: "missing",
      }),
    ).rejects.toMatchObject(
      new BoardItemRouteError(
        "BOARD_CONTAINER_NOT_FOUND",
        "Task board container not found",
        404,
      ),
    );
    const taskCalls = harness.calls.filter((call) =>
      call.text.includes("board_yjs_catalog_cache")
    );
    expect(taskCalls).toHaveLength(3);
    expect(taskCalls[0]?.text).toContain("container_kind = 'task'");
    expect(taskCalls[0]?.text).toContain("container_id =");
    expect(taskCalls[0]?.text).toContain("LIMIT 1");
    expect(taskCalls[0]?.text).not.toContain("board_item_get_all");
    expect(taskCalls[0]?.values).toEqual(["task-1"]);
    const identityCalls = harness.calls.filter((call) => call.text.includes("FROM tasks task"));
    expect(identityCalls).toHaveLength(2);
    expect(identityCalls[0]?.text).toContain("JOIN board_items");
    expect(identityCalls[0]?.values).toEqual(["task-new"]);
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
    container_kind: "folder",
    container_id: "folder-a",
    membership_kind: "primary",
    source_task_item_id: null,
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
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return rowsFor(text, values);
  }) as unknown as LivePostgresSql;

  return {
    sql,
    calls,
    normalizedCalls: () =>
      calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}
