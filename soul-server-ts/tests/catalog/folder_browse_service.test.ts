import { describe, expect, it, vi } from "vitest";

import { FOLDER_SEARCH_SCAN_LIMIT, FolderBrowseService, type FolderBrowseStore } from "../../src/catalog/folder_browse_service.js";
import type { CatalogBoardItemRow, ListFolderItemsResult } from "../../src/db/session_db_types.js";

function item(itemType: CatalogBoardItemRow["itemType"], itemId: string): CatalogBoardItemRow {
  return { id: `${itemType}:${itemId}`, folderId: "folder-1", membershipKind: "primary",
    itemType, itemId, x: 0, y: 0, metadata: {}, updatedAt: "2026-07-16T00:00:00.000Z" };
}

const emptyResult: ListFolderItemsResult = {
  items: [], total: 0,
  counts: { session: 0, markdown: 0, subfolder: 0, asset: 0, frame: 0, custom_view: 0 },
  scan: null,
};

function makeStore(result: ListFolderItemsResult) {
  const listFolderItems = vi.fn(async () => result);
  const getFolderById = vi.fn(async () => ({ id: "folder-1" }) as never);
  return { store: { listFolderItems, getFolderById } as FolderBrowseStore, listFolderItems, getFolderById };
}

describe("FolderBrowseService", () => {
  it("uses session display name, then preview, then an untitled fallback", async () => {
    const { store } = makeStore({ ...emptyResult, items: [
      { boardItem: item("session", "named"), archived: false, session: { agentSessionId: "named", displayName: "  이름 있는 세션  " } as never },
      { boardItem: item("session", "preview"), archived: false, session: { agentSessionId: "preview", displayName: null, lastUserMessagePreview: "  최신\n사용자 😀 발화  " } as never },
      { boardItem: item("session", "untitled"), archived: false, session: { agentSessionId: "untitled", displayName: "", lastUserMessagePreview: "" } as never },
    ] });
    const result = await new FolderBrowseService(store).browse({ folderId: "folder-1" });
    expect(result.items.map((entry) => entry.type === "session" ? entry.displayName : null)).toEqual([
      "이름 있는 세션", "최신 사용자 😀 발화", "제목 없는 세션",
    ]);
  });

  it("returns codepoint-safe markdown previews", async () => {
    const body = `${"가".repeat(239)}😀끝`;
    const { store } = makeStore({ ...emptyResult, items: [
      { boardItem: item("markdown", "doc-1"), archived: false, markdown: { id: "doc-1", title: "명세", body } as never },
    ] });
    const result = await new FolderBrowseService(store).browse({ folderId: "folder-1" });
    const markdown = result.items[0];
    expect(markdown).toEqual(expect.objectContaining({ type: "markdown", title: "명세" }));
    if (markdown?.type !== "markdown") throw new Error("expected markdown");
    expect(Array.from(markdown.preview)).toHaveLength(240);
    expect(markdown.preview.endsWith("…")).toBe(true);
  });

  it("clamps browse and search limits and keeps reads in one folder", async () => {
    expect(FOLDER_SEARCH_SCAN_LIMIT).toBe(2_000);
    const { store, listFolderItems } = makeStore({ ...emptyResult, total: 275,
      scan: { limit: 2_000, scannedItems: 2_000, truncated: true } });
    const service = new FolderBrowseService(store);
    const browse = await service.browse({ folderId: "folder-1", cursor: 100, limit: 999, includeArchived: true });
    expect(browse.page).toEqual({ cursor: 100, limit: 100, total: 275, nextCursor: 200 });
    expect(listFolderItems).toHaveBeenNthCalledWith(1, expect.objectContaining({
      folderId: "folder-1", cursor: 100, limit: 100, includeArchived: true, query: null,
    }));
    const search = await service.search({ folderId: "folder-1", query: "  명세 😀  ", limit: 999 });
    expect(listFolderItems).toHaveBeenNthCalledWith(2, expect.objectContaining({
      folderId: "folder-1", cursor: 0, limit: 50, query: "명세 😀",
      itemTypes: ["session", "markdown"], scanLimit: 2_000,
    }));
    expect(search.search).toEqual({ scanLimit: 2_000, scannedItems: 2_000, truncated: true });
  });

  it("rejects missing folders before reading board items", async () => {
    const { store, listFolderItems, getFolderById } = makeStore(emptyResult);
    getFolderById.mockResolvedValueOnce(null as never);
    await expect(new FolderBrowseService(store).browse({ folderId: "missing" }))
      .rejects.toThrow("folder not found: missing");
    expect(listFolderItems).not.toHaveBeenCalled();
  });
});
