import {
  BOARD_TILE_HEIGHT,
  BOARD_TILE_WIDTH,
  snapBoardPosition,
  type BoardWorkspaceItem,
} from "./board-workspace-items";

export interface BoardPoint {
  x: number;
  y: number;
}

export interface BoardRect extends BoardPoint {
  width: number;
  height: number;
}

export interface BoardItemPositionUpdate {
  boardItemId: string;
  x: number;
  y: number;
}

export function normalizeBoardRect(start: BoardPoint, end: BoardPoint): BoardRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function getBoardItemRect(item: BoardWorkspaceItem): BoardRect {
  return {
    x: item.x,
    y: item.y,
    width: BOARD_TILE_WIDTH,
    height: BOARD_TILE_HEIGHT,
  };
}

export function boardRectsIntersect(a: BoardRect, b: BoardRect): boolean {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
}

export function findBoardItemsInRect(items: BoardWorkspaceItem[], rect: BoardRect): string[] {
  return items
    .filter((item) => boardRectsIntersect(getBoardItemRect(item), rect))
    .map((item) => item.boardItemId);
}

export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export function isBoardSelectionToggle(
  event: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (event.shiftKey) return true;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}

export function getDraggedBoardItems(
  items: BoardWorkspaceItem[],
  selectedBoardItemIds: Set<string>,
  activeItem: BoardWorkspaceItem,
): BoardWorkspaceItem[] {
  if (!selectedBoardItemIds.has(activeItem.boardItemId) || selectedBoardItemIds.size <= 1) {
    return [activeItem];
  }
  const selectedItems = items.filter((item) => selectedBoardItemIds.has(item.boardItemId));
  return [
    activeItem,
    ...selectedItems.filter((item) => item.boardItemId !== activeItem.boardItemId),
  ];
}

export function snapBoardItemPositionUpdates(updates: BoardItemPositionUpdate[]): BoardItemPositionUpdate[] {
  return updates.map((update) => {
    const snapped = snapBoardPosition(update.x, update.y);
    return {
      boardItemId: update.boardItemId,
      x: snapped.x,
      y: snapped.y,
    };
  });
}
