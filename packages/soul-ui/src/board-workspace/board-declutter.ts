import type { BoardItemPositionUpdate } from "./board-selection";
import {
  BOARD_GRID_SIZE,
  getBoardItemHeight,
  getBoardItemWidth,
  snapBoardPosition,
  type BoardWorkspaceItem,
} from "./board-workspace-items";

interface BoardDeclutterRect {
  boardItemId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectForItem(item: BoardWorkspaceItem, position = { x: item.x, y: item.y }): BoardDeclutterRect {
  return {
    boardItemId: item.boardItemId,
    x: position.x,
    y: position.y,
    width: getBoardItemWidth(item),
    height: getBoardItemHeight(item),
  };
}

function rectsOverlap(a: BoardDeclutterRect, b: BoardDeclutterRect): boolean {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
}

function rectsConflictWithMargin(
  a: BoardDeclutterRect,
  b: BoardDeclutterRect,
  margin = BOARD_GRID_SIZE,
): boolean {
  return a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y;
}

function snapUpBoardCoordinate(value: number): number {
  return Math.ceil(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE;
}

function spiralOffset(index: number, step: number): { x: number; y: number } {
  if (index === 0) return { x: 0, y: 0 };
  const ring = Math.ceil((Math.sqrt(index + 1) - 1) / 2);
  const side = ring * 2;
  const maxIndex = (side + 1) ** 2 - 1;
  const offset = maxIndex - index;
  const radius = ring * step;

  if (offset < side) return { x: radius - offset * step, y: radius };
  if (offset < side * 2) return { x: -radius, y: radius - (offset - side) * step };
  if (offset < side * 3) return { x: -radius + (offset - side * 2) * step, y: -radius };
  return { x: radius, y: -radius + (offset - side * 3) * step };
}

function hasMarginConflict(rect: BoardDeclutterRect, occupied: readonly BoardDeclutterRect[]): boolean {
  return occupied.some((candidate) => rectsConflictWithMargin(rect, candidate));
}

function findNearestAvailablePosition(
  item: BoardWorkspaceItem,
  occupied: readonly BoardDeclutterRect[],
): { x: number; y: number } {
  const origin = snapBoardPosition(item.x, item.y);
  const maxCandidates = Math.max(10_000, occupied.length * occupied.length * 64);

  for (let index = 0; index < maxCandidates; index += 1) {
    const offset = spiralOffset(index, BOARD_GRID_SIZE);
    const position = {
      x: origin.x + offset.x,
      y: origin.y + offset.y,
    };
    const candidate = rectForItem(item, position);
    if (!hasMarginConflict(candidate, occupied)) return position;
  }

  const bottom = occupied.reduce((max, rect) => Math.max(max, rect.y + rect.height), origin.y);
  return {
    x: origin.x,
    y: snapUpBoardCoordinate(bottom + BOARD_GRID_SIZE),
  };
}

export function declutterBoardItems(items: readonly BoardWorkspaceItem[]): BoardItemPositionUpdate[] {
  if (items.length <= 1) return [];

  const stationaryRects: BoardDeclutterRect[] = [];
  const movingItems: BoardWorkspaceItem[] = [];
  const movingBoardItemIds = new Set<string>();

  for (const item of items) {
    const rect = rectForItem(item);
    if (stationaryRects.some((candidate) => rectsOverlap(rect, candidate))) {
      movingItems.push(item);
      movingBoardItemIds.add(item.boardItemId);
    } else {
      stationaryRects.push(rect);
    }
  }

  if (movingItems.length === 0) return [];

  const occupied = items
    .filter((item) => !movingBoardItemIds.has(item.boardItemId))
    .map((item) => rectForItem(item));
  const updates: BoardItemPositionUpdate[] = [];

  for (const item of movingItems) {
    const next = findNearestAvailablePosition(item, occupied);
    occupied.push(rectForItem(item, next));
    if (next.x === item.x && next.y === item.y) continue;
    updates.push({
      boardItemId: item.boardItemId,
      x: next.x,
      y: next.y,
    });
  }

  return updates;
}
