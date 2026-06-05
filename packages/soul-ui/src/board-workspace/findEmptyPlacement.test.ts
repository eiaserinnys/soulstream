import { describe, expect, it } from "vitest";

import { findEmptyPlacement } from "./findEmptyPlacement";
import { BOARD_TILE_HEIGHT, BOARD_TILE_WIDTH } from "./board-workspace-items";

const size = { width: BOARD_TILE_WIDTH, height: BOARD_TILE_HEIGHT };

function item(id: string, x: number, y: number, width = BOARD_TILE_WIDTH, height = BOARD_TILE_HEIGHT) {
  return { id, x, y, width, height };
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
}

describe("findEmptyPlacement", () => {
  it("returns the preferred point when it is empty", () => {
    expect(findEmptyPlacement({
      existingItems: [],
      preferredPoint: { x: 40, y: 80 },
      size,
    })).toEqual([{ x: 40, y: 80 }]);
  });

  it("uses AABB collision checks instead of exact coordinate matching", () => {
    const [position] = findEmptyPlacement({
      existingItems: [item("a", 0, 0)],
      preferredPoint: { x: 20, y: 20 },
      size,
    });

    expect(position).not.toEqual({ x: 20, y: 20 });
    expect(overlaps(
      { ...position, ...size },
      { x: 0, y: 0, ...size },
    )).toBe(false);
  });

  it("reserves placements internally for multi-drop batches", () => {
    const positions = findEmptyPlacement({
      existingItems: [item("a", 0, 0)],
      preferredPoint: { x: 0, y: 0 },
      size,
      count: 3,
    });

    expect(new Set(positions.map((p) => `${p.x}:${p.y}`)).size).toBe(3);
    expect(positions).not.toContainEqual({ x: 0, y: 0 });
  });

  it("supports negative board coordinates", () => {
    expect(findEmptyPlacement({
      existingItems: [],
      preferredPoint: { x: -640, y: -80 },
      size,
    })).toEqual([{ x: -640, y: -80 }]);
  });
});
