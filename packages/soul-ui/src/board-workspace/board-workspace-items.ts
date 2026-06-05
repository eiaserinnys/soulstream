import type { CatalogBoardItem, CatalogFolder, CatalogState, SessionSummary } from "../shared/types";

export const BOARD_GRID_SIZE = 20;
export const BOARD_TILE_WIDTH = 160;
export const BOARD_TILE_HEIGHT = 120;
export const BOARD_CANVAS_BUFFER = 200;
export const BOARD_CANVAS_WIDTH = 20000;
export const BOARD_CANVAS_HEIGHT = 12000;
export const BOARD_CANVAS_ORIGIN_X = BOARD_CANVAS_WIDTH / 2;
export const BOARD_CANVAS_ORIGIN_Y = BOARD_CANVAS_HEIGHT / 2;

export interface FolderBoardWorkspaceItem {
  type: "folder";
  id: string;
  boardItemId: string;
  folder: CatalogFolder;
  childCount: number;
  x: number;
  y: number;
}

export interface SessionBoardWorkspaceItem {
  type: "session";
  id: string;
  boardItemId: string;
  session: SessionSummary;
  x: number;
  y: number;
}

export interface MarkdownBoardWorkspaceItem {
  type: "markdown";
  id: string;
  boardItemId: string;
  documentId: string;
  title: string;
  preview: string;
  x: number;
  y: number;
}

export type BoardWorkspaceItem =
  | FolderBoardWorkspaceItem
  | SessionBoardWorkspaceItem
  | MarkdownBoardWorkspaceItem;

export interface BuildBoardWorkspaceItemsParams {
  catalog: CatalogState;
  selectedFolderId: string | null;
  sessions: readonly SessionSummary[];
}

function parseTimeMs(value: string | undefined | null): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function getSessionActivityMs(session: SessionSummary): number {
  return parseTimeMs(session.lastMessage?.timestamp ?? session.updatedAt ?? session.createdAt);
}

export function getFolderActivityMs(folder: CatalogFolder): number {
  return parseTimeMs(folder.createdAt);
}

export function getSessionBoardTitle(session: SessionSummary): string {
  return session.displayName || session.prompt || session.agentSessionId;
}

export function getSessionBoardPreview(session: SessionSummary): string {
  return session.lastMessage?.preview || session.prompt || "No preview";
}

export function formatBoardWorkspaceTime(value: string | undefined | null): string {
  const ms = parseTimeMs(value);
  if (!ms) return "...";
  return new Date(ms).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getFolderDirectChildCount(catalog: CatalogState, folderId: string): number {
  if (catalog.boardItems) {
    return catalog.boardItems.filter((item) => item.folderId === folderId).length;
  }
  const childFolderCount = catalog.folders.filter((folder) => (folder.parentFolderId ?? null) === folderId).length;
  const sessionCount = Object.values(catalog.sessions).filter((assignment) => assignment.folderId === folderId).length;
  return childFolderCount + sessionCount;
}

function metadataText(item: CatalogBoardItem, key: string): string {
  const value = item.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function buildPositionedItems({
  catalog,
  selectedFolderId,
  sessions,
}: BuildBoardWorkspaceItemsParams): BoardWorkspaceItem[] {
  const folderById = new Map(catalog.folders.map((folder) => [folder.id, folder]));
  const sessionById = new Map(sessions.map((session) => [session.agentSessionId, session]));
  const selectedId = selectedFolderId ?? "";
  const items: BoardWorkspaceItem[] = [];

  for (const boardItem of catalog.boardItems ?? []) {
    if (boardItem.folderId !== selectedId) continue;
    if (boardItem.itemType === "subfolder") {
      const folder = folderById.get(boardItem.itemId);
      if (!folder) continue;
      items.push({
        type: "folder",
        id: folder.id,
        boardItemId: boardItem.id,
        folder,
        childCount: getFolderDirectChildCount(catalog, folder.id),
        x: boardItem.x,
        y: boardItem.y,
      });
      continue;
    }
    if (boardItem.itemType === "session") {
      const session = sessionById.get(boardItem.itemId);
      if (!session) continue;
      items.push({
        type: "session",
        id: session.agentSessionId,
        boardItemId: boardItem.id,
        session,
        x: boardItem.x,
        y: boardItem.y,
      });
      continue;
    }
    if (boardItem.itemType === "markdown") {
      items.push({
        type: "markdown",
        id: boardItem.itemId,
        boardItemId: boardItem.id,
        documentId: boardItem.itemId,
        title: metadataText(boardItem, "title") || "Untitled document",
        preview: metadataText(boardItem, "preview"),
        x: boardItem.x,
        y: boardItem.y,
      });
    }
  }

  return items.sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}

export function buildBoardWorkspaceItems({
  catalog,
  selectedFolderId,
  sessions,
}: BuildBoardWorkspaceItemsParams): BoardWorkspaceItem[] {
  if (catalog.boardItems) {
    return buildPositionedItems({ catalog, selectedFolderId, sessions });
  }

  const folderItems: FolderBoardWorkspaceItem[] = catalog.folders
    .filter((folder) => (folder.parentFolderId ?? null) === selectedFolderId)
    .map((folder, index) => ({
      type: "folder" as const,
      id: folder.id,
      boardItemId: `subfolder:${folder.id}`,
      folder,
      childCount: getFolderDirectChildCount(catalog, folder.id),
      x: (index % 4) * BOARD_TILE_WIDTH,
      y: Math.floor(index / 4) * BOARD_TILE_HEIGHT,
    }));

  const sessionItems: SessionBoardWorkspaceItem[] = sessions.map((session, index) => ({
    type: "session" as const,
    id: session.agentSessionId,
    boardItemId: `session:${session.agentSessionId}`,
    session,
    x: ((folderItems.length + index) % 4) * BOARD_TILE_WIDTH,
    y: Math.floor((folderItems.length + index) / 4) * BOARD_TILE_HEIGHT,
  }));

  return [...folderItems, ...sessionItems];
}

export function snapBoardCoordinate(value: number): number {
  return Math.round(value / BOARD_GRID_SIZE) * BOARD_GRID_SIZE;
}

export function snapBoardPosition(x: number, y: number): { x: number; y: number } {
  return { x: snapBoardCoordinate(x), y: snapBoardCoordinate(y) };
}

export function findFirstOpenBoardPosition(items: readonly BoardWorkspaceItem[]): { x: number; y: number } {
  const occupied = new Set(items.map((item) => `${item.x}:${item.y}`));
  let index = 0;
  while (true) {
    const x = (index % 4) * BOARD_TILE_WIDTH;
    const y = Math.floor(index / 4) * BOARD_TILE_HEIGHT;
    if (!occupied.has(`${x}:${y}`)) return { x, y };
    index += 1;
  }
}

export function computeBoardCanvasSize(items: readonly BoardWorkspaceItem[]): { width: number; height: number } {
  const maxX = items.reduce((max, item) => Math.max(max, item.x), 0);
  const maxY = items.reduce((max, item) => Math.max(max, item.y), 0);
  return {
    width: maxX + BOARD_TILE_WIDTH + BOARD_CANVAS_BUFFER,
    height: maxY + BOARD_TILE_HEIGHT + BOARD_CANVAS_BUFFER,
  };
}
