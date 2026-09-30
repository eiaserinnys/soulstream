import { describe, expect, it, vi } from "vitest";
import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import {
  createPlannerDataDependencies,
  loadDailyPlanner,
  loadFolderSessionPage,
  loadFolderSubfolderPage,
  loadPlannerFolderById,
  loadFolderPlanner,
  loadStarredFolders,
} from "./planner-data";

const page = (id: string): PageDto => ({ id, title: id, metadata: {} }) as PageDto;
const folder = (id: string) => ({
  id, name: id, sortOrder: 0, parentFolderId: null, projectPageId: `${id}-page`,
  checklistEnabled: false, status: "open" as const, archived: false, version: 1, settings: {},
});
const entry = (id: string) => ({ folder: folder(id), page: page(`${id}-page`),
  itemCounts: {}, itemTotal: 0, completedItemCount: 0, assignee: null });
const api = {} as PageApiClient;

describe("unified folder planner API", () => {
  it("uses the page ID to save starred folder order", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    const dependencies = createPlannerDataDependencies(fetcher as typeof fetch);
    await dependencies.saveStarredFolderOrder?.("page-a", "page-b");
    expect(fetcher).toHaveBeenCalledWith("/api/planner/starred-folders/order", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ pageId: "page-a", beforePageId: "page-b" }),
    }));
  });

  it("reads today as one folder list with no page fanout", async () => {
    const fetchPlanner = vi.fn(async () => ({
      daily: { page: page("daily"), blocks: [], state_vector: "" },
      attention: [], running: [], queued: [], folders: [entry("folder-a")], memoBlocks: [], reviewSessionIds: [],
    }));
    const result = await loadDailyPlanner(api, "2026-09-29", { fetchPlanner });
    expect(result.folders).toMatchObject([{ folderId: "folder-a", page: { id: "folder-a-page" } }]);
    expect(fetchPlanner).toHaveBeenCalledOnce();
    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/today?date=2026-09-29");
  });

  it("reads the folder aggregate including each first cursor slice", async () => {
    const fetchPlanner = vi.fn(async () => ({
      folder: folder("folder-a"), page: page("folder-a-page"), blocks: [], sections: [], cards: [],
      subfolders: { items: [folder("child")], nextCursor: "sub-next" },
      sessions: { items: [{ agentSessionId: "session-a" }], nextCursor: "session-next" },
    }));
    const result = await loadFolderPlanner(api, "folder-a", page("folder-a-page"), { fetchPlanner });
    expect(result).toMatchObject({
      subfolders: [{ id: "child" }], nextSubfolderCursor: "sub-next",
      sessions: { items: [{ agentSessionId: "session-a" }], nextCursor: "session-next" },
    });
    expect(result).not.toHaveProperty("documents");
    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/folders/folder-a");
  });

  it("uses one cursor route per folder collection", async () => {
    const fetchPlanner = vi.fn(async (_path: string) => ({ items: [], nextCursor: "next" }));
    const dependencies = { fetchPlanner };
    await loadFolderSubfolderPage(dependencies, "folder/a", "child-cursor");
    await loadFolderSessionPage(dependencies, "folder/a", "session-cursor");
    expect(fetchPlanner.mock.calls.map(([path]) => path)).toEqual([
      "/api/planner/folders/folder%2Fa/subfolders?cursor=child-cursor",
      "/api/planner/folders/folder%2Fa/sessions?cursor=session-cursor",
    ]);
  });

  it("opens a folder by its identity without reading an old task route", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      folder: folder("folder-a"), page: page("folder-a-page"), blocks: [], sections: [], cards: [],
      subfolders: { items: [], nextCursor: null },
      sessions: { items: [], nextCursor: null },
    }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await loadPlannerFolderById(api, "folder-a");
      expect(result).toMatchObject({ folderId: "folder-a", page: { id: "folder-a-page" } });
      expect(fetcher).toHaveBeenCalledWith("/api/planner/folders/folder-a", expect.any(Object));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads starred folders from the new route", async () => {
    const fetchPlanner = vi.fn(async () => ({ items: [entry("folder-a")], nextCursor: null }));
    const result = await loadStarredFolders({ fetchPlanner }, {});
    expect(result.items).toMatchObject([{ folderId: "folder-a" }]);
    expect(fetchPlanner).toHaveBeenCalledWith("/api/planner/starred-folders");
  });
});
