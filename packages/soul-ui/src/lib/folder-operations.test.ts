import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogState } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { createFolderOperations } from "./folder-operations";

const catalog: CatalogState = {
  folders: [
    { id: "claude", name: "이름이 바뀐 클로드 폴더", sortOrder: 0, parentFolderId: null },
    { id: "normal", name: "Normal", sortOrder: 1, parentFolderId: null },
  ],
  sessions: {},
};

function makeOperations() {
  return createFolderOperations({
    createUrl: "/api/folders",
    updateUrl: (id) => `/api/folders/${id}`,
    deleteUrl: (id) => `/api/folders/${id}`,
    reorderUrl: "/api/folders/reorder",
    deleteFallbackFolderId: "claude",
  });
}

describe("folder operations system-folder protection", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setCatalog(catalog);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not rename system folders optimistically or through the API", async () => {
    await makeOperations().renameFolderOptimistic("claude", "Renamed");

    expect(fetch).not.toHaveBeenCalled();
    expect(useDashboardStore.getState().catalog?.folders.find((f) => f.id === "claude")?.name)
      .toBe("이름이 바뀐 클로드 폴더");
  });

  it("does not delete system folders optimistically or through the API", async () => {
    useDashboardStore.getState().selectFolder("claude");

    await makeOperations().deleteFolderOptimistic("claude");

    expect(fetch).not.toHaveBeenCalled();
    expect(useDashboardStore.getState().catalog?.folders.some((f) => f.id === "claude")).toBe(true);
    expect(useDashboardStore.getState().selectedFolderId).toBe("claude");
  });

  it("does not reorder system folders optimistically or through the API", async () => {
    await makeOperations().reorderFoldersOptimistic([{ id: "claude", sortOrder: 99 }]);

    expect(fetch).not.toHaveBeenCalled();
    expect(useDashboardStore.getState().catalog?.folders.find((f) => f.id === "claude")?.sortOrder)
      .toBe(0);
  });

  it("uses an explicit fallback folder id instead of the first remaining folder after deletion", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
    useDashboardStore.getState().selectFolder("normal");

    await makeOperations().deleteFolderOptimistic("normal");

    expect(useDashboardStore.getState().selectedFolderId).toBe("claude");
  });
});
