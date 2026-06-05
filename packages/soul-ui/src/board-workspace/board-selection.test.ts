import { describe, expect, it } from "vitest";

import type { BoardWorkspaceItem } from "./board-workspace-items";
import {
  boardRectsIntersect,
  findBoardItemsInRect,
  getDraggedBoardItems,
  isBoardSelectionToggle,
  normalizeBoardRect,
  snapBoardItemPositionUpdates,
} from "./board-selection";

const items = [
  { boardItemId: "a", x: 0, y: 0 },
  { boardItemId: "b", x: 240, y: 40 },
  { boardItemId: "c", x: 800, y: 0 },
] as BoardWorkspaceItem[];

describe("board-selection", () => {
  it("normalizes marquee rectangles regardless of drag direction", () => {
    expect(normalizeBoardRect({ x: 120, y: 80 }, { x: 20, y: 160 })).toEqual({
      x: 20,
      y: 80,
      width: 100,
      height: 80,
    });
  });

  it("selects board items whose tile rectangles intersect the marquee", () => {
    expect(boardRectsIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 99, y: 50, width: 20, height: 20 })).toBe(true);
    expect(findBoardItemsInRect(items, { x: -20, y: -20, width: 620, height: 220 })).toEqual(["a", "b"]);
  });

  it("uses Cmd on macOS and Ctrl elsewhere for toggle selection", () => {
    expect(isBoardSelectionToggle({ shiftKey: false, metaKey: true, ctrlKey: false }, "MacIntel")).toBe(true);
    expect(isBoardSelectionToggle({ shiftKey: false, metaKey: true, ctrlKey: false }, "Win32")).toBe(false);
    expect(isBoardSelectionToggle({ shiftKey: false, metaKey: false, ctrlKey: true }, "Linux x86_64")).toBe(true);
    expect(isBoardSelectionToggle({ shiftKey: true, metaKey: false, ctrlKey: false }, "Linux x86_64")).toBe(true);
  });

  it("drags every selected board item while keeping the active item first", () => {
    expect(getDraggedBoardItems(items, new Set(["a", "b"]), items[1]).map((item) => item.boardItemId)).toEqual(["b", "a"]);
    expect(getDraggedBoardItems(items, new Set(["a"]), items[1]).map((item) => item.boardItemId)).toEqual(["b"]);
  });

  it("snaps batched position updates to the board grid", () => {
    expect(snapBoardItemPositionUpdates([
      { boardItemId: "a", x: 21, y: 39 },
      { boardItemId: "b", x: -11, y: -29 },
    ])).toEqual([
      { boardItemId: "a", x: 20, y: 40 },
      { boardItemId: "b", x: -20, y: -20 },
    ]);
  });
});
