import { describe, expect, it, vi } from "vitest";

import {
  FolderRouteError,
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  text: string;
  values: unknown[];
};

describe("live DB folder route providers", () => {
  it("lists folders, session assignments, and counts from the same repository", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("folder_get_all")) {
        return [
          folderRow({
            id: "folder-a",
            settings: { icon: "inbox" },
            created_at: new Date("2026-07-09T01:00:00.000Z"),
          }),
          folderRow({
            id: "folder-b",
            parent_folder_id: "folder-a",
            sort_order: 2,
            settings: "{\"color\":\"blue\"}",
          }),
        ];
      }
      if (text.includes("session_id, folder_id, display_name FROM sessions")) {
        return [
          { session_id: "sess-a", folder_id: "folder-a", display_name: "Named session" },
          { session_id: "sess-root", folder_id: null, display_name: null },
        ];
      }
      if (text.includes("GROUP BY folder_id")) {
        return [
          { folder_id: "folder-a", count: 3 },
          { folder_id: null, count: 2 },
        ];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(repository.folderRouteProvider.listFolders()).resolves.toEqual([
      {
        id: "folder-a",
        name: "Folder",
        sortOrder: 1,
        parentFolderId: null,
        settings: { icon: "inbox" },
        createdAt: "2026-07-09T01:00:00.000Z",
      },
      {
        id: "folder-b",
        name: "Folder",
        sortOrder: 2,
        parentFolderId: "folder-a",
        settings: { color: "blue" },
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    ]);
    await expect(repository.folderRouteProvider.listSessionAssignments()).resolves.toEqual({
      "sess-a": { folderId: "folder-a", displayName: "Named session" },
      "sess-root": { folderId: null, displayName: null },
    });
    await expect(repository.folderCountsProvider.listFolders()).resolves.toMatchObject([
      { id: "folder-a", parentFolderId: null },
      { id: "folder-b", parentFolderId: "folder-a" },
    ]);

    const counts = await repository.folderCountsProvider.getFolderCounts();
    expect(counts).toBeInstanceOf(Map);
    expect([...(counts as Map<string | null, number>).entries()]).toEqual([
      ["folder-a", 3],
      [null, 2],
    ]);
    expect(harness.normalizedCalls()).toEqual([
      "SELECT * FROM folder_get_all()",
      "SELECT session_id, folder_id, display_name FROM sessions",
      "SELECT * FROM folder_get_all()",
      expect.stringContaining("GROUP BY folder_id"),
    ]);
  });

  it("creates, updates, and deletes folders through DB functions", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("SELECT id, parent_folder_id FROM folders")) {
        return [
          { id: "parent", parent_folder_id: null },
          { id: "folder-a", parent_folder_id: "parent" },
        ];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    const created = await repository.folderRouteProvider.createFolder("New", 7, {
      parentFolderId: "parent",
    });
    expect(created).toMatchObject({
      name: "New",
      sortOrder: 7,
      parentFolderId: "parent",
      settings: {},
    });
    const createCall = harness.calls.find((call) => call.text.includes("folder_create"));
    expect(createCall?.values.slice(1)).toEqual(["New", 7, "parent"]);

    await repository.folderRouteProvider.updateFolder("folder-a", {
      name: "Renamed",
      sortOrder: 4,
      settings: { collapsed: true },
      parentFolderId: null,
    });
    const updateCall = harness.calls.find((call) => call.text.includes("folder_update"));
    expect(updateCall?.values).toEqual([
      "folder-a",
      ["name", "sort_order", "settings", "parent_folder_id"],
      ["Renamed", "4", "{\"collapsed\":true}", null],
    ]);

    const beforeNoop = harness.calls.length;
    await repository.folderRouteProvider.updateFolder("folder-a", {});
    expect(harness.calls).toHaveLength(beforeNoop);
    await repository.folderRouteProvider.updateFolder("folder-a", {
      name: null,
      sortOrder: null,
      settings: null,
    });
    expect(harness.calls).toHaveLength(beforeNoop);

    await repository.folderRouteProvider.deleteFolder("folder-a");
    expect(harness.normalizedCalls()).toContain("SELECT folder_delete(?)");
  });

  it("validates reorder parent changes before writing", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("SELECT id, parent_folder_id FROM folders")) {
        return [
          { id: "folder-a", parent_folder_id: null },
          { id: "folder-b", parent_folder_id: "folder-a" },
        ];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.folderRouteProvider.reorderFolders([
        { id: "folder-a", sortOrder: 1, parentFolderId: "folder-b" },
      ]),
    ).rejects.toMatchObject(
      new FolderRouteError("FOLDER_PARENT_CYCLE", "folder parent cycle", 400),
    );
    await expect(
      repository.folderRouteProvider.reorderFolders([
        { id: "folder-b", sortOrder: 1, parentFolderId: "missing" },
      ]),
    ).rejects.toThrow("Parent folder not found");
    expect(harness.normalizedCalls().filter((call) => call.includes("folder_update"))).toEqual([]);

    await repository.folderRouteProvider.reorderFolders([
      { id: "folder-a", sortOrder: 1 },
      { id: "folder-b", sortOrder: 2, parentFolderId: null },
    ]);
    const updateCalls = harness.calls.filter((call) => call.text.includes("folder_update"));
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]?.values).toEqual(["folder-a", ["sort_order"], ["1"]]);
    expect(updateCalls[1]?.values).toEqual([
      "folder-b",
      ["sort_order", "parent_folder_id"],
      ["2", null],
    ]);
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
