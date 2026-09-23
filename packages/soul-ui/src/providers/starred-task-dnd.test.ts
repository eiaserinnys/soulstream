import { describe, expect, it } from "vitest";

import { reorderStarredTaskIds } from "./starred-task-dnd";

describe("reorderStarredTaskIds", () => {
  it("moves the active row to the hovered neighbor's visible position", () => {
    expect(reorderStarredTaskIds(["a", "b", "c"], "a", "c"))
      .toEqual(["b", "c", "a"]);
    expect(reorderStarredTaskIds(["a", "b", "c"], "c", "a"))
      .toEqual(["c", "a", "b"]);
  });

  it("ignores absent IDs and drops onto the same row", () => {
    expect(reorderStarredTaskIds(["a", "b"], "missing", "b")).toBeNull();
    expect(reorderStarredTaskIds(["a", "b"], "a", "a")).toBeNull();
  });
});
