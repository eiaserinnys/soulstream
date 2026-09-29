import { describe, expect, it, vi } from "vitest";

import {
  disableStarredFolderPaginationAfterRefreshFailure,
  isStarredFolderBoundaryCurrent,
  isStarredFolderRequestCurrent,
  isStarredFolderRefreshCurrent,
  isStarredFolderSnapshotCurrent,
  reconcileStarredFolderOrderReloadFailure,
  resolveStarredFolderBoundaryPageId,
  resolveStarredFolderBeforePageId,
  resolveStarredFolderDropBoundary,
  saveStarredFolderOrderAndReload,
} from "./starred-folder-order";

describe("starred task order boundaries", () => {
  it("uses the visible successor, requests a cursor boundary for a partial end, and only nulls at the full end", () => {
    expect(resolveStarredFolderDropBoundary(["a", "b", "c"], "b", true))
      .toEqual({ kind: "before", pageId: "c" });
    expect(resolveStarredFolderDropBoundary(["a", "b", "c"], "c", true))
      .toEqual({ kind: "next-page" });
    expect(resolveStarredFolderDropBoundary(["a", "b", "c"], "c", false))
      .toEqual({ kind: "end" });
  });

  it("uses the next cursor page's first ID and rejects empty, repeated, or duplicate boundaries", () => {
    expect(resolveStarredFolderBoundaryPageId(["a", "b"], "cursor-a", ["c", "d"], "cursor-b"))
      .toBe("c");
    expect(resolveStarredFolderBoundaryPageId(["a", "b"], "cursor-a", [], null)).toBeNull();
    expect(resolveStarredFolderBoundaryPageId(["a", "b"], "cursor-a", ["c"], "cursor-a"))
      .toBeNull();
    expect(resolveStarredFolderBoundaryPageId(["a", "b"], "cursor-a", ["b", "c"], "cursor-b"))
      .toBeNull();
  });

  it("fetches the opaque next cursor for a partial-list end and never substitutes null on boundary failure", async () => {
    const fetchBoundaryPage = vi.fn(async (cursor: string) => {
      expect(cursor).toBe("opaque-cursor");
      return { pageIds: ["unloaded-first", "unloaded-second"], nextCursor: null };
    });
    await expect(resolveStarredFolderBeforePageId({
      orderedPageIds: ["b", "a"],
      movedPageId: "a",
      nextCursor: "opaque-cursor",
      fetchBoundaryPage,
    })).resolves.toBe("unloaded-first");
    await expect(resolveStarredFolderBeforePageId({
      orderedPageIds: ["a", "b"],
      movedPageId: "b",
      nextCursor: "opaque-cursor",
      fetchBoundaryPage: async () => ({ pageIds: [], nextCursor: null }),
    })).rejects.toThrow("경계");
  });

  it("rejects a stale boundary after a second-page reorder even when first-page IDs and cursor are unchanged", () => {
    expect(isStarredFolderBoundaryCurrent({
      expectedRefreshKey: 4,
      currentRefreshKey: 5,
      expectedOrderRevision: 1,
      currentOrderRevision: 1,
      expectedCursor: "cursor-first-page",
      currentCursor: "cursor-first-page",
      expectedPageIds: ["a", "b"],
      currentPageIds: ["a", "b"],
    })).toBe(false);
  });

  it("rejects a first-page response started before a starred order mutation", () => {
    const orderBeforeMutation = 8;
    const orderDuringMutation = orderBeforeMutation + 1;
    const orderAfterMutation = orderDuringMutation + 1;
    expect(isStarredFolderRequestCurrent({
      expectedRefreshKey: 5,
      currentRefreshKey: 5,
      expectedOrderRevision: orderBeforeMutation,
      currentOrderRevision: orderAfterMutation,
    })).toBe(false);
    expect(isStarredFolderRequestCurrent({
      expectedRefreshKey: 5,
      currentRefreshKey: 5,
      expectedOrderRevision: orderDuringMutation,
      currentOrderRevision: orderAfterMutation,
    })).toBe(false);
    expect(isStarredFolderRequestCurrent({
      expectedRefreshKey: 5,
      currentRefreshKey: 5,
      expectedOrderRevision: orderAfterMutation,
      currentOrderRevision: orderAfterMutation,
    })).toBe(true);
  });

  it("keeps stale starred snapshots from enabling reorder or pagination", () => {
    expect(isStarredFolderRefreshCurrent(null, 5)).toBe(false);
    expect(isStarredFolderRefreshCurrent(4, 5)).toBe(false);
    expect(isStarredFolderRefreshCurrent(5, 5)).toBe(true);
  });

  it("preserves a loaded snapshot after a failed retry only within its refresh and order revision", () => {
    const current = {
      loadedRefreshKey: 7,
      expectedRefreshKey: 7,
      currentRefreshKey: 7,
      expectedOrderRevision: 3,
      currentOrderRevision: 3,
    };
    expect(isStarredFolderSnapshotCurrent(current)).toBe(true);
    expect(isStarredFolderSnapshotCurrent({ ...current, loadedRefreshKey: null })).toBe(false);
    expect(isStarredFolderSnapshotCurrent({ ...current, currentRefreshKey: 8 })).toBe(false);
    expect(isStarredFolderSnapshotCurrent({ ...current, currentOrderRevision: 4 })).toBe(false);
  });

  it("reloads the first page after a failed save so optimistic order can roll back", async () => {
    const reload = vi.fn(async () => ({ items: ["server-order"] }));
    const result = await saveStarredFolderOrderAndReload({
      save: async () => { throw new Error("409 stale member"); },
      reload,
    });

    expect(result).toMatchObject({ saved: false, reloaded: { items: ["server-order"] } });
    expect(result.saveError).toBeInstanceOf(Error);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("discards a reload superseded by a newer starred invalidation", async () => {
    let refreshKey = 4;
    let resolveReload: ((page: { items: string[] }) => void) | undefined;
    const pending = saveStarredFolderOrderAndReload({
      save: async () => undefined,
      reload: async () => await new Promise((resolve) => { resolveReload = resolve; }),
      isReloadCurrent: () => refreshKey === 4,
    });
    await vi.waitFor(() => expect(resolveReload).toBeTypeOf("function"));

    refreshKey += 1;
    resolveReload!({ items: ["outdated-order"] });

    await expect(pending).resolves.toMatchObject({ saved: true, reloadSuperseded: true });
  });

  it("invalidates the old cursor when the saved order cannot be reloaded", () => {
    expect(disableStarredFolderPaginationAfterRefreshFailure({
      items: ["a", "b"],
      nextCursor: "old-cursor",
    })).toEqual({
      items: ["a", "b"],
      nextCursor: null,
    });
  });

  it("rolls back a failed reorder and disables its cursor when the newer refresh has not loaded", () => {
    expect(reconcileStarredFolderOrderReloadFailure({
      currentPage: { items: ["optimistic"], nextCursor: "old-cursor" },
      originalPage: { items: ["original"], nextCursor: "old-cursor" },
      saved: false,
      reloadSuperseded: true,
      loadedRefreshKey: 4,
      currentRefreshKey: 5,
    })).toEqual({ items: ["original"], nextCursor: null });
  });

  it("preserves a concurrently completed refresh instead of restoring stale reorder data", () => {
    expect(reconcileStarredFolderOrderReloadFailure({
      currentPage: { items: ["fresh"], nextCursor: "fresh-cursor" },
      originalPage: { items: ["original"], nextCursor: "old-cursor" },
      saved: false,
      reloadSuperseded: true,
      loadedRefreshKey: 5,
      currentRefreshKey: 5,
    })).toBeNull();
  });
});
