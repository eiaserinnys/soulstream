import { describe, expect, it, vi } from "vitest";

import {
  disableStarredTaskPaginationAfterRefreshFailure,
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

  it("invalidates the old cursor when the saved order cannot be reloaded", () => {
    expect(disableStarredTaskPaginationAfterRefreshFailure({
      items: ["a", "b"],
      nextCursor: "old-cursor",
    })).toEqual({
      items: ["a", "b"],
      nextCursor: null,
    });
  });
});
