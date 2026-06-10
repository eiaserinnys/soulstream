import type { CatalogBoardItem } from "../shared/types";
import type { BoardItemPositionUpdate } from "./board-selection";
import type { BoardWorkspaceItem, FrameBoardWorkspaceItem } from "./board-workspace-items";

export const BOARD_FRAME_DEFAULT_TITLE = "Frame";
export const BOARD_FRAME_DEFAULT_WIDTH = 640;
export const BOARD_FRAME_DEFAULT_HEIGHT = 420;
export const BOARD_FRAME_COLLAPSED_WIDTH = 280;
export const BOARD_FRAME_COLLAPSED_HEIGHT = 160;
const FRAME_PADDING = 40;

export interface BoardFrameMetadata {
  title: string;
  collapsed: boolean;
  childItemIds: string[];
  width: number;
  height: number;
}

export interface CreateFrameBoardItemInput {
  folderId: string;
  frameId: string;
  x: number;
  y: number;
  title?: string;
  width?: number;
  height?: number;
  childItemIds?: string[];
  collapsed?: boolean;
}

function metadataRecord(item: Pick<CatalogBoardItem, "metadata">): Record<string, unknown> {
  return item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
    ? item.metadata
    : {};
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function metadataBoolean(metadata: Record<string, unknown>, key: string): boolean | undefined {
  const value = metadata[key];
  return typeof value === "boolean" ? value : undefined;
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function uniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function getBoardFrameMetadata(item: Pick<CatalogBoardItem, "metadata">): BoardFrameMetadata {
  const metadata = metadataRecord(item);
  return {
    title: metadataString(metadata, "title")?.trim() || BOARD_FRAME_DEFAULT_TITLE,
    collapsed: metadataBoolean(metadata, "collapsed") ?? false,
    childItemIds: uniqueIds(metadataStringArray(metadata, "childItemIds")),
    width: metadataNumber(metadata, "width") ?? BOARD_FRAME_DEFAULT_WIDTH,
    height: metadataNumber(metadata, "height") ?? BOARD_FRAME_DEFAULT_HEIGHT,
  };
}

export function createFrameBoardItem({
  folderId,
  frameId,
  x,
  y,
  title = BOARD_FRAME_DEFAULT_TITLE,
  width = BOARD_FRAME_DEFAULT_WIDTH,
  height = BOARD_FRAME_DEFAULT_HEIGHT,
  childItemIds = [],
  collapsed = false,
}: CreateFrameBoardItemInput): CatalogBoardItem {
  return {
    id: frameId,
    folderId,
    itemType: "frame",
    itemId: frameId,
    x,
    y,
    metadata: {
      title: title.trim() || BOARD_FRAME_DEFAULT_TITLE,
      collapsed,
      childItemIds: uniqueIds(childItemIds),
      width,
      height,
    },
  };
}

export function frameItemToCatalogBoardItem(
  frame: FrameBoardWorkspaceItem,
  overrides: Partial<BoardFrameMetadata> & Partial<Pick<CatalogBoardItem, "x" | "y">> = {},
): CatalogBoardItem {
  const childItemIds = overrides.childItemIds ?? frame.childItemIds;
  return createFrameBoardItem({
    folderId: frame.folderId,
    frameId: frame.boardItemId,
    x: overrides.x ?? frame.x,
    y: overrides.y ?? frame.y,
    title: overrides.title ?? frame.title,
    width: overrides.width ?? frame.width,
    height: overrides.height ?? frame.height,
    collapsed: overrides.collapsed ?? frame.collapsed,
    childItemIds,
  });
}

export function isFrameChildCandidate(item: BoardWorkspaceItem): boolean {
  return item.type !== "frame";
}

function itemCenter(item: BoardWorkspaceItem): { x: number; y: number } {
  const width = "width" in item ? item.width : BOARD_FRAME_COLLAPSED_WIDTH;
  const height = "height" in item ? item.height : BOARD_FRAME_COLLAPSED_HEIGHT;
  return {
    x: item.x + width / 2,
    y: item.y + height / 2,
  };
}

function frameContainsItem(frame: FrameBoardWorkspaceItem, item: BoardWorkspaceItem): boolean {
  if (!isFrameChildCandidate(item)) return false;
  const center = itemCenter(item);
  const width = frame.collapsed ? BOARD_FRAME_COLLAPSED_WIDTH : frame.width;
  const height = frame.collapsed ? BOARD_FRAME_COLLAPSED_HEIGHT : frame.height;
  return center.x >= frame.x &&
    center.x <= frame.x + width &&
    center.y >= frame.y &&
    center.y <= frame.y + height;
}

export function buildFrameMoveUpdates(
  items: readonly BoardWorkspaceItem[],
  update: BoardItemPositionUpdate,
): BoardItemPositionUpdate[] {
  const frame = items.find(
    (item): item is FrameBoardWorkspaceItem =>
      item.type === "frame" && item.boardItemId === update.boardItemId,
  );
  if (!frame) return [update];

  const deltaX = update.x - frame.x;
  const deltaY = update.y - frame.y;
  const updates: BoardItemPositionUpdate[] = [update];
  for (const childId of frame.childItemIds) {
    const child = items.find((item) => item.boardItemId === childId);
    if (!child) continue;
    updates.push({
      boardItemId: child.boardItemId,
      x: child.x + deltaX,
      y: child.y + deltaY,
    });
  }
  return updates;
}

export function expandFramePositionUpdates(
  items: readonly BoardWorkspaceItem[],
  updates: readonly BoardItemPositionUpdate[],
): BoardItemPositionUpdate[] {
  const next = new Map<string, BoardItemPositionUpdate>();
  for (const update of updates) {
    for (const expanded of buildFrameMoveUpdates(items, update)) {
      next.set(expanded.boardItemId, expanded);
    }
  }
  return Array.from(next.values());
}

export function applyBoardItemPositionUpdates(
  items: readonly BoardWorkspaceItem[],
  updates: readonly BoardItemPositionUpdate[],
): BoardWorkspaceItem[] {
  const updateById = new Map(updates.map((update) => [update.boardItemId, update]));
  return items.map((item) => {
    const update = updateById.get(item.boardItemId);
    return update ? { ...item, x: update.x, y: update.y } : item;
  });
}

export function buildFrameMembershipUpdates(
  items: readonly BoardWorkspaceItem[],
  movedBoardItemIds: readonly string[],
): CatalogBoardItem[] {
  const movedIds = new Set(movedBoardItemIds);
  const movedItems = items.filter((item) => movedIds.has(item.boardItemId) && isFrameChildCandidate(item));
  if (movedItems.length === 0) return [];

  const frames = items.filter((item): item is FrameBoardWorkspaceItem => item.type === "frame");
  const updates: CatalogBoardItem[] = [];

  for (const frame of frames) {
    const nextChildIds = frame.childItemIds.filter((childId) => !movedIds.has(childId));
    for (const item of movedItems) {
      if (frameContainsItem(frame, item)) nextChildIds.push(item.boardItemId);
    }
    const uniqueChildIds = uniqueIds(nextChildIds);
    if (sameIds(uniqueChildIds, frame.childItemIds)) continue;
    updates.push(frameItemToCatalogBoardItem(frame, { childItemIds: uniqueChildIds }));
  }

  return updates;
}

export function getFrameCreationRect(
  items: readonly BoardWorkspaceItem[],
  fallback: { x: number; y: number },
): { x: number; y: number; width: number; height: number; childItemIds: string[] } {
  const candidates = items.filter(isFrameChildCandidate);
  if (candidates.length === 0) {
    return {
      x: fallback.x,
      y: fallback.y,
      width: BOARD_FRAME_DEFAULT_WIDTH,
      height: BOARD_FRAME_DEFAULT_HEIGHT,
      childItemIds: [],
    };
  }

  const minX = Math.min(...candidates.map((item) => item.x));
  const minY = Math.min(...candidates.map((item) => item.y));
  const maxX = Math.max(...candidates.map((item) => item.x + ("width" in item ? item.width : BOARD_FRAME_COLLAPSED_WIDTH)));
  const maxY = Math.max(...candidates.map((item) => item.y + ("height" in item ? item.height : BOARD_FRAME_COLLAPSED_HEIGHT)));
  return {
    x: minX - FRAME_PADDING,
    y: minY - FRAME_PADDING,
    width: Math.max(BOARD_FRAME_DEFAULT_WIDTH, maxX - minX + FRAME_PADDING * 2),
    height: Math.max(BOARD_FRAME_DEFAULT_HEIGHT, maxY - minY + FRAME_PADDING * 2),
    childItemIds: candidates.map((item) => item.boardItemId),
  };
}
