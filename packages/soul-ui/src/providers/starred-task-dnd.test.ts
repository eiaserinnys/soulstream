import { describe, expect, it } from "vitest";

import { reorderStarredFolderIds } from "./starred-task-dnd";

describe("reorderStarredFolderIds", () => {
  it("moves the active row to the hovered neighbor's visible position", () => {
    expect(reorderStarredFolderIds(["a", "b", "c"], "a", "c"))
      .toEqual(["b", "c", "a"]);
    expect(reorderStarredFolderIds(["a", "b", "c"], "c", "a"))
      .toEqual(["c", "a", "b"]);
  });

  it("ignores absent IDs and drops onto the same row", () => {
    expect(reorderStarredFolderIds(["a", "b"], "missing", "b")).toBeNull();
    expect(reorderStarredFolderIds(["a", "b"], "a", "a")).toBeNull();
  });
});
