import { describe, expect, it } from "vitest";

import { createContiguousBlockSelection } from "./page-editor-selection";

describe("page editor contiguous selection", () => {
  const ids = ["a", "b", "c", "d"] as const;

  it("extends and contracts a contiguous range from a stable anchor", () => {
    const selection = createContiguousBlockSelection(ids);
    selection.select("b");
    selection.extend("d");
    expect(selection.getSnapshot()).toEqual({ anchorId: "b", focusId: "d", blockIds: ["b", "c", "d"] });
    selection.extend("a");
    expect(selection.getSnapshot()).toEqual({ anchorId: "b", focusId: "a", blockIds: ["a", "b"] });
  });

  it("moves the focus edge by keyboard while keeping the range contiguous", () => {
    const selection = createContiguousBlockSelection(ids);
    selection.select("b");
    selection.extendBy(-1);
    expect(selection.getSnapshot().blockIds).toEqual(["a", "b"]);
    selection.extendBy(1);
    selection.extendBy(1);
    expect(selection.getSnapshot().blockIds).toEqual(["b", "c"]);
  });

  it("extends across four blocks, contracts, and grows past the anchor in reverse", () => {
    const selection = createContiguousBlockSelection(["a", "b", "c", "d", "e"]);
    selection.select("b");
    selection.extendBy(1);
    selection.extendBy(1);
    selection.extendBy(1);
    expect(selection.getSnapshot()).toEqual({
      anchorId: "b",
      focusId: "e",
      blockIds: ["b", "c", "d", "e"],
    });

    selection.extendBy(-1);
    selection.extendBy(-1);
    selection.extendBy(-1);
    selection.extendBy(-1);
    expect(selection.getSnapshot()).toEqual({
      anchorId: "b",
      focusId: "a",
      blockIds: ["a", "b"],
    });
  });

  it("selects every visible block from the first through the last boundary", () => {
    const selection = createContiguousBlockSelection(ids);

    selection.selectAll();

    expect(selection.getSnapshot()).toEqual({
      anchorId: "a",
      focusId: "d",
      blockIds: ["a", "b", "c", "d"],
    });
  });
});
