import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogState } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { createFolderOperations } from "./folder-operations";

const catalog: CatalogState = {
  folders: [
    { status: "open", version: 1, archived: false, id: "claude", name: "클로드", sortOrder: 0, parentFolderId: null },
    { status: "open", archived: false, id: "normal", name: "폴더", sortOrder: 1, parentFolderId: null, version: 2 },
  ], sessions: {},
};

const operations = createFolderOperations({
  createUrl: "/api/folders", updateUrl: (id) => `/api/folders/${id}`,
  archiveUrl: (id) => `/api/folders/${id}/archive`, reorderUrl: "/api/folders/reorder",
  archiveFallbackFolderId: "claude",
});

describe("folder operations", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setCatalog(catalog);
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("protects system folders from rename, archive, and reorder", async () => {
    await operations.renameFolderOptimistic("claude", "Renamed");
    await operations.archiveFolder("claude");
    await operations.reorderFoldersOptimistic([{ id: "claude", sortOrder: 99 }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(useDashboardStore.getState().catalog?.folders.find((folder) => folder.id === "claude")?.name).toBe("클로드");
  });

  it("archives a folder without deleting its catalog entry or moving sessions", async () => {
    const archived = { ...catalog.folders[1], archived: true, version: 3 };
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ folder: archived }) } as Response);
    useDashboardStore.getState().selectFolder("normal");
    await operations.archiveFolder("normal");
    expect(fetch).toHaveBeenCalledWith("/api/folders/normal/archive", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body).toMatchObject({ expectedVersion: 2, idempotencyKey: expect.any(String) });
    expect(useDashboardStore.getState().catalog?.folders.find((folder) => folder.id === "normal")?.archived).toBe(true);
    expect(useDashboardStore.getState().selectedFolderId).toBe("claude");
  });
});
