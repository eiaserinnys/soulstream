import { describe, expect, it } from "vitest";

import { boardRectsIntersect } from "./board-selection";
import { findOpenBoardPositionInViewport } from "./board-spawn";
import { BOARD_TILE_HEIGHT, BOARD_TILE_WIDTH, type BoardWorkspaceItem } from "./board-workspace-items";

function sessionItem(id: string, x: number, y: number): BoardWorkspaceItem {
  return {
    type: "session",
    id,
    boardItemId: `session:${id}`,
    session: {
      agentSessionId: id,
      status: "running",
      eventCount: 1,
    },
    x,
    y,
  };
}

describe("board spawn placement", () => {
  it("spawns at the viewport center instead of the origin when the center is empty", () => {
    const position = findOpenBoardPositionInViewport([], {
      viewport: { scrollLeft: 10_000, scrollTop: 6_000, width: 1_000, height: 600 },
      zoom: 1,
    });

    expect(position).toEqual({ x: 360, y: 220 });
  });

  it("uses AABB collision checks and searches for the first non-overlapping viewport slot", () => {
    const occupied = sessionItem("occupied", 360, 220);
    const position = findOpenBoardPositionInViewport([occupied], {
      viewport: { scrollLeft: 10_000, scrollTop: 6_000, width: 1_000, height: 600 },
      zoom: 1,
    });

    expect(position).not.toEqual({ x: 360, y: 220 });
    expect(boardRectsIntersect(
      { x: position.x, y: position.y, width: BOARD_TILE_WIDTH, height: BOARD_TILE_HEIGHT },
      { x: occupied.x, y: occupied.y, width: BOARD_TILE_WIDTH, height: BOARD_TILE_HEIGHT },
    )).toBe(false);
    expect(position.x).toBeGreaterThanOrEqual(0);
    expect(position.y).toBeGreaterThanOrEqual(0);
    expect(position.x + BOARD_TILE_WIDTH).toBeLessThanOrEqual(1_000);
    expect(position.y + BOARD_TILE_HEIGHT).toBeLessThanOrEqual(600);
  });

  it("falls back to a deterministic random offset when the viewport cannot fit a tile", () => {
    const position = findOpenBoardPositionInViewport([], {
      viewport: { scrollLeft: 10_000, scrollTop: 6_000, width: 100, height: 80 },
      zoom: 1,
      maxAttempts: 0,
      random: () => 1,
    });

    expect(position).toEqual({ x: 60, y: 100 });
  });
});
