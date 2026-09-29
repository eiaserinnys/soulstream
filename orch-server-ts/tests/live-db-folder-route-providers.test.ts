import { describe, expect, it, vi } from "vitest";

import {
  FolderRouteError,
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  text: string;
  values: unknown[];
  inTransaction: boolean;
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
      if (text.includes("SELECT folder_id FROM sessions")) {
        return [{ folder_id: "folder-a" }];
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
        archived: false, checklistEnabled: false, status: "open", version: 1,
        id: "folder-a",
        name: "Folder",
        sortOrder: 1,
        parentFolderId: null,
        projectPageId: null,
        settings: { icon: "inbox" },
        createdAt: "2026-07-09T01:00:00.000Z",
      },
      {
        archived: false, checklistEnabled: false, status: "open", version: 1,
        id: "folder-b",
        name: "Folder",
        sortOrder: 2,
        parentFolderId: "folder-a",
        projectPageId: null,
        settings: { color: "blue" },
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    ]);
    await expect(repository.folderRouteProvider.listSessionAssignments()).resolves.toEqual({
      "sess-a": { folderId: "folder-a", displayName: "Named session" },
      "sess-root": { folderId: null, displayName: null },
    });
    await expect(repository.folderRouteProvider.findSessionFolderId("sess-a"))
      .resolves.toBe("folder-a");
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
      "SELECT folder_id FROM sessions WHERE session_id = ? LIMIT 1",
      "SELECT * FROM folder_get_all()",
      expect.stringContaining("GROUP BY folder_id"),
    ]);
  });


});

function folderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "folder-a",
    name: "Folder",
    status: "open", version: 1, checklist_enabled: false,
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
  let inTransaction = false;
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values, inTransaction });
    return rowsFor(text, values);
  }) as unknown as LivePostgresSql & {
    begin: <T>(callback: (sql: LivePostgresSql) => Promise<T>) => Promise<T>;
  };
  const begin = vi.fn(async (
    callback: (transaction: LivePostgresSql) => Promise<unknown>,
  ): Promise<unknown> => {
    inTransaction = true;
    try {
      return await callback(sql);
    } finally {
      inTransaction = false;
    }
  });
  sql.begin = begin as typeof sql.begin;

  return {
    sql,
    calls,
    begin,
    normalizedCalls: () =>
      calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}
