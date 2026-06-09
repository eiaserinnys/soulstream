import { describe, expect, it } from "vitest";

import { declutterBoardItems } from "./board-declutter";
import {
  BOARD_GRID_SIZE,
  BOARD_TILE_HEIGHT,
  BOARD_TILE_WIDTH,
  type BoardWorkspaceItem,
} from "./board-workspace-items";

function item(id: string, x: number, y: number): BoardWorkspaceItem {
  return {
    type: "folder",
    id,
    boardItemId: id,
    folder: {
      id,
      name: id,
      sortOrder: 0,
      parentFolderId: null,
      createdAt: "2026-06-10T00:00:00.000Z",
    },
    childCount: 0,
    x,
    y,
  };
}

function rect(position: { x: number; y: number }) {
  return {
    ...position,
    width: BOARD_TILE_WIDTH,
    height: BOARD_TILE_HEIGHT,
  };
}

function overlapsWithMargin(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  margin = BOARD_GRID_SIZE,
) {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

describe("declutterBoardItems", () => {
  it("returns no updates for empty, single, and non-overlapping boards", () => {
    expect(declutterBoardItems([])).toEqual([]);
    expect(declutterBoardItems([item("a", 0, 0)])).toEqual([]);
    expect(declutterBoardItems([
      item("a", 0, 0),
      item("b", BOARD_TILE_WIDTH + BOARD_GRID_SIZE, 0),
    ])).toEqual([]);
  });

  it("moves only the later overlapped cards and preserves independent cards", () => {
    const items = [
      item("anchor", 0, 0),
      item("overlapped", 120, 0),
      item("independent", 700, 0),
    ];

    const updates = declutterBoardItems(items);

    expect(updates.map((update) => update.boardItemId)).toEqual(["overlapped"]);
    expect(updates[0]).not.toMatchObject({ x: 120, y: 0 });
    expect(overlapsWithMargin(rect(updates[0]), rect(items[0]))).toBe(false);
    expect(overlapsWithMargin(rect(updates[0]), rect(items[2]))).toBe(false);
  });

  it("spreads a stack of cards without moving the first anchor", () => {
    const items = Array.from({ length: 5 }, (_, index) => item(`card-${index}`, 0, 0));
    const updates = declutterBoardItems(items);
    const finalById = new Map(items.map((candidate) => [candidate.boardItemId, { x: candidate.x, y: candidate.y }]));

    for (const update of updates) {
      finalById.set(update.boardItemId, { x: update.x, y: update.y });
    }

    expect(updates).toHaveLength(4);
    expect(finalById.get("card-0")).toEqual({ x: 0, y: 0 });

    const finalRects = items.map((candidate) => rect(finalById.get(candidate.boardItemId)!));
    for (let i = 0; i < finalRects.length; i += 1) {
      for (let j = i + 1; j < finalRects.length; j += 1) {
        expect(overlapsWithMargin(finalRects[i], finalRects[j])).toBe(false);
      }
    }
  });
});
