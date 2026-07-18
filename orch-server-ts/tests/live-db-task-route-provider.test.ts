import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  text: string;
  values: unknown[];
};

describe("live DB task route provider", () => {
  it("reads folders and Python-shaped task overview rows", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("folder_get_all")) return [folderRow()];
      if (text.includes("LIMIT")) return [overviewItemRow({ item_id: "item-review" })];
      if (text.includes("completed_count")) return [overviewGroupRow()];
      if (text.includes("CASE i.status")) return [overviewItemRow({ item_id: "item-open" })];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(repository.taskRouteProvider.listFolders()).resolves.toEqual([
      expect.objectContaining({ id: "folder-a", parentFolderId: null }),
    ]);
    await expect(
      repository.taskRouteProvider.getTaskOverview?.({
        userId: "user@example.com",
        limit: 25,
      }),
    ).resolves.toEqual({
      my_turn_items: [
        expect.objectContaining({
          item_id: "item-review",
          item_version: 3,
          folder_id: "folder-a",
        }),
      ],
      tasks: [
        expect.objectContaining({
          task_id: "task-1",
          task_version: 2,
          completed_count: 1,
          total_count: 3,
          items: [
            expect.objectContaining({
              item_id: "item-open",
              item_version: 3,
              folder_id: "folder-a",
            }),
          ],
        }),
      ],
    });
    expect(harness.normalizedCalls()).toEqual([
      "SELECT * FROM folder_get_all()",
      expect.stringContaining("LIMIT ?"),
      expect.stringContaining("completed_count"),
      expect.stringContaining("CASE i.status"),
    ]);
  });

  it("reads Python-shaped task snapshots", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("SELECT r.*, bi.folder_id")) return [taskRow()];
      if (text.includes("FROM task_sections")) return [sectionRow()];
      if (text.includes("FROM task_items")) return [itemRow()];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.taskRouteProvider.getTaskSnapshot?.("task-1"),
    ).resolves.toEqual({
      task: expect.objectContaining({
        id: "task-1",
        folder_id: "folder-a",
        version: 2,
        created_at: "2026-07-09T01:00:00.000Z",
      }),
      sections: [
        expect.objectContaining({
          id: "section-1",
          created_at: "2026-07-09T01:01:00.000Z",
        }),
      ],
      items: [
        expect.objectContaining({
          id: "item-1",
          section_id: "section-1",
          created_session_id: "sess-created",
        }),
      ],
    });
  });

  it("resolves mutation nodes through the TS runtime registry", async () => {
    const registry = new InMemoryNodeRegistry({ nowMs: () => 1_700_000_000_000 });
    registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      host: "127.0.0.1",
      port: 4105,
    });
    registry.registerNode({
      type: "node_register",
      node_id: "node-z",
      host: "127.0.0.2",
      port: 4106,
    });
    const harness = createSqlHarness((text, values) => {
      if (!text.includes("session_get")) return [];
      if (values[0] === "sess-owned") return [{ session_id: "sess-owned", node_id: "node-z" }];
      if (values[0] === "sess-legacy") return [{ session_id: "sess-legacy", node_id: null }];
      if (values[0] === "sess-stale") return [{ session_id: "sess-stale", node_id: "node-missing" }];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql, registry });

    await expect(
      repository.taskRouteProvider.findSessionNode?.("sess-owned"),
    ).resolves.toMatchObject({ nodeId: "node-z", host: "127.0.0.2", port: 4106 });
    await expect(
      repository.taskRouteProvider.findSessionNode?.("sess-legacy"),
    ).resolves.toMatchObject({ nodeId: "node-a", host: "127.0.0.1", port: 4105 });
    await expect(
      repository.taskRouteProvider.findSessionNode?.("sess-stale"),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: "Session owner node unavailable: node-missing",
    });
    await expect(
      repository.taskRouteProvider.findSessionNode?.("missing"),
    ).rejects.toMatchObject({ statusCode: 404, message: "Session not found" });
    expect(repository.taskRouteProvider.listConnectedNodes?.()).toEqual([
      expect.objectContaining({ nodeId: "node-a", host: "127.0.0.1", port: 4105 }),
      expect.objectContaining({ nodeId: "node-z", host: "127.0.0.2", port: 4106 }),
    ]);
  });
});

function folderRow(): Record<string, unknown> {
  return {
    id: "folder-a",
    name: "Folder",
    sort_order: 1,
    parent_folder_id: null,
    settings: {},
  };
}

function overviewItemRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: "task-1",
    task_title: "Task",
    task_status: "open",
    board_item_id: "task:task-1",
    folder_id: "folder-a",
    section_id: "section-1",
    section_title: "Section",
    item_id: "item-1",
    item_title: "Item",
    how_to: "Do it",
    status: "review",
    item_version: "3",
    task_created_session_id: "sess-task",
    item_created_session_id: "sess-created",
    ...overrides,
  };
}

function overviewGroupRow(): Record<string, unknown> {
  return {
    task_id: "task-1",
    task_title: "Task",
    task_version: "2",
    task_status: "open",
    board_item_id: "task:task-1",
    folder_id: "folder-a",
    updated_at: new Date("2026-07-09T01:10:00.000Z"),
    completed_count: "1",
    total_count: "3",
    my_turn_count: "1",
    in_progress_count: "0",
  };
}

function taskRow(): Record<string, unknown> {
  return {
    id: "task-1",
    board_item_id: "task:task-1",
    title: "Task",
    version: 2,
    status: "open",
    folder_id: "folder-a",
    created_session_id: "sess-task",
    created_at: new Date("2026-07-09T01:00:00.000Z"),
    updated_at: new Date("2026-07-09T01:10:00.000Z"),
  };
}

function sectionRow(): Record<string, unknown> {
  return {
    id: "section-1",
    task_id: "task-1",
    title: "Section",
    created_at: new Date("2026-07-09T01:01:00.000Z"),
  };
}

function itemRow(): Record<string, unknown> {
  return {
    id: "item-1",
    section_id: "section-1",
    title: "Item",
    status: "pending",
    created_session_id: "sess-created",
    created_at: new Date("2026-07-09T01:02:00.000Z"),
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
