import {
  BOARD_GRID_SIZE,
  BOARD_TILE_HEIGHT,
  BOARD_TILE_WIDTH,
  snapBoardPosition,
} from "./board-workspace-items";

export interface BoardPlacementItem {
  id?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface BoardPlacementPoint {
  x: number;
  y: number;
}

export interface BoardPlacementSize {
  width: number;
  height: number;
}

export interface FindEmptyPlacementParams {
  existingItems: readonly BoardPlacementItem[];
  preferredPoint: BoardPlacementPoint;
  size: BoardPlacementSize;
  count?: number;
}

interface BoardPlacementRect extends BoardPlacementPoint, BoardPlacementSize {}

function rectForItem(item: BoardPlacementItem): BoardPlacementRect {
  return {
    x: item.x,
    y: item.y,
    width: item.width ?? BOARD_TILE_WIDTH,
    height: item.height ?? BOARD_TILE_HEIGHT,
  };
}

function rectsOverlap(a: BoardPlacementRect, b: BoardPlacementRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function collides(candidate: BoardPlacementRect, occupied: readonly BoardPlacementRect[]): boolean {
  return occupied.some((rect) => rectsOverlap(candidate, rect));
}

function spiralPoint(origin: BoardPlacementPoint, index: number): BoardPlacementPoint {
  if (index === 0) return origin;
  let remaining = index;
  for (let ring = 1; ; ring += 1) {
    const sideLength = ring * 2;
    const ringCount = sideLength * 4;
    if (remaining > ringCount) {
      remaining -= ringCount;
      continue;
    }

    const x0 = origin.x - ring * BOARD_GRID_SIZE;
    const y0 = origin.y - ring * BOARD_GRID_SIZE;
    if (remaining <= sideLength) {
      return { x: x0 + remaining * BOARD_GRID_SIZE, y: y0 };
    }
    remaining -= sideLength;
    if (remaining <= sideLength) {
      return { x: origin.x + ring * BOARD_GRID_SIZE, y: y0 + remaining * BOARD_GRID_SIZE };
    }
    remaining -= sideLength;
    if (remaining <= sideLength) {
      return { x: origin.x + ring * BOARD_GRID_SIZE - remaining * BOARD_GRID_SIZE, y: origin.y + ring * BOARD_GRID_SIZE };
    }
    remaining -= sideLength;
    return { x: x0, y: origin.y + ring * BOARD_GRID_SIZE - remaining * BOARD_GRID_SIZE };
  }
}

export function findEmptyPlacement({
  existingItems,
  preferredPoint,
  size,
  count = 1,
}: FindEmptyPlacementParams): BoardPlacementPoint[] {
  const targetCount = Math.max(0, count);
  const origin = snapBoardPosition(preferredPoint.x, preferredPoint.y);
  const occupied = existingItems.map(rectForItem);
  const placements: BoardPlacementPoint[] = [];
  let candidateIndex = 0;

  while (placements.length < targetCount) {
    const point = spiralPoint(origin, candidateIndex);
    candidateIndex += 1;
    const candidate = { ...point, ...size };
    if (collides(candidate, occupied)) continue;
    occupied.push(candidate);
    placements.push(point);
  }

  return placements;
}
