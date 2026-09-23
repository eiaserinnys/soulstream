import { describe, expect, it, vi } from "vitest";

import {
  disableStarredTaskPaginationAfterRefreshFailure,
  isStarredTaskBoundaryCurrent,
  reconcileStarredTaskOrderReloadFailure,
  resolveStarredTaskBoundaryPageId,
  resolveStarredTaskBeforePageId,
  resolveStarredTaskDropBoundary,
  saveStarredTaskOrderAndReload,
} from "./starred-task-order";

describe("starred task order boundaries", () => {
  it("uses the visible successor, requests a cursor boundary for a partial end, and only nulls at the full end", () => {
    expect(resolveStarredTaskDropBoundary(["a", "b", "c"], "b", true))
      .toEqual({ kind: "before", pageId: "c" });
    expect(resolveStarredTaskDropBoundary(["a", "b", "c"], "c", true))
      .toEqual({ kind: "next-page" });
    expect(resolveStarredTaskDropBoundary(["a", "b", "c"], "c", false))
      .toEqual({ kind: "end" });
  });

  it("uses the next cursor page's first ID and rejects empty, repeated, or duplicate boundaries", () => {
    expect(resolveStarredTaskBoundaryPageId(["a", "b"], "cursor-a", ["c", "d"], "cursor-b"))
      .toBe("c");
    expect(resolveStarredTaskBoundaryPageId(["a", "b"], "cursor-a", [], null)).toBeNull();
    expect(resolveStarredTaskBoundaryPageId(["a", "b"], "cursor-a", ["c"], "cursor-a"))
      .toBeNull();
    expect(resolveStarredTaskBoundaryPageId(["a", "b"], "cursor-a", ["b", "c"], "cursor-b"))
      .toBeNull();
  });

  it("fetches the opaque next cursor for a partial-list end and never substitutes null on boundary failure", async () => {
    const fetchBoundaryPage = vi.fn(async (cursor: string) => {
      expect(cursor).toBe("opaque-cursor");
      return { pageIds: ["unloaded-first", "unloaded-second"], nextCursor: null };
    });
    await expect(resolveStarredTaskBeforePageId({
      orderedPageIds: ["b", "a"],
      movedPageId: "a",
      nextCursor: "opaque-cursor",
      fetchBoundaryPage,
    })).resolves.toBe("unloaded-first");
    await expect(resolveStarredTaskBeforePageId({
      orderedPageIds: ["a", "b"],
      movedPageId: "b",
      nextCursor: "opaque-cursor",
      fetchBoundaryPage: async () => ({ pageIds: [], nextCursor: null }),
    })).rejects.toThrow("경계");
  });

  it("rejects a stale boundary after a second-page reorder even when first-page IDs and cursor are unchanged", () => {
    expect(isStarredTaskBoundaryCurrent({
      expectedRefreshKey: 4,
      currentRefreshKey: 5,
      expectedCursor: "cursor-first-page",
      currentCursor: "cursor-first-page",
      expectedPageIds: ["a", "b"],
      currentPageIds: ["a", "b"],
    })).toBe(false);
  });

  it("reloads the first page after a failed save so optimistic order can roll back", async () => {
    const reload = vi.fn(async () => ({ items: ["server-order"] }));
    const result = await saveStarredTaskOrderAndReload({
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
    const pending = saveStarredTaskOrderAndReload({
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
    expect(disableStarredTaskPaginationAfterRefreshFailure({
      items: ["a", "b"],
      nextCursor: "old-cursor",
    })).toEqual({
      items: ["a", "b"],
      nextCursor: null,
    });
  });

  it("rolls back a failed reorder and disables its cursor when the newer refresh has not loaded", () => {
    expect(reconcileStarredTaskOrderReloadFailure({
      currentPage: { items: ["optimistic"], nextCursor: "old-cursor" },
      originalPage: { items: ["original"], nextCursor: "old-cursor" },
      saved: false,
      reloadSuperseded: true,
      loadedRefreshKey: 4,
      currentRefreshKey: 5,
    })).toEqual({ items: ["original"], nextCursor: null });
  });

  it("preserves a concurrently completed refresh instead of restoring stale reorder data", () => {
    expect(reconcileStarredTaskOrderReloadFailure({
      currentPage: { items: ["fresh"], nextCursor: "fresh-cursor" },
      originalPage: { items: ["original"], nextCursor: "old-cursor" },
      saved: false,
      reloadSuperseded: true,
      loadedRefreshKey: 5,
      currentRefreshKey: 5,
    })).toBeNull();
  });
});
