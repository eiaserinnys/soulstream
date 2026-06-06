import type { CatalogBoardItem, CatalogFolder, CatalogState, SessionSummary } from "../shared/types";
import {
  buildBoardSessionRelations,
  getSessionChildStack,
  getSessionParentRef,
  shouldSuppressSessionInFolder,
  type BoardSessionRelationIndex,
  type SessionChildStack,
  type SessionParentRef,
} from "./board-session-relations";

export const BOARD_GRID_SIZE = 20;
export const BOARD_TILE_WIDTH = 280;
export const BOARD_TILE_HEIGHT = 160;
export const BOARD_ASSET_TILE_HEIGHT = 200;
export const BOARD_CANVAS_BUFFER = 200;
export const BOARD_CANVAS_WIDTH = 20000;
export const BOARD_CANVAS_HEIGHT = 12000;
export const BOARD_CANVAS_ORIGIN_X = BOARD_CANVAS_WIDTH / 2;
export const BOARD_CANVAS_ORIGIN_Y = BOARD_CANVAS_HEIGHT / 2;

export function boardToCanvasStyle(position: { x: number; y: number }) {
  return {
    left: BOARD_CANVAS_ORIGIN_X + position.x,
    top: BOARD_CANVAS_ORIGIN_Y + position.y,
  };
}

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
  childStack?: SessionChildStack;
  parentRef?: SessionParentRef;
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
  version: number;
  x: number;
  y: number;
}

export interface AssetBoardWorkspaceItem {
  type: "asset";
  id: string;
  boardItemId: string;
  assetId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  signedUrl?: string;
  sourceUrl?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  durationSeconds?: number;
  uploadProgress?: number;
  uploadState?: "uploading" | "error";
  errorMessage?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BoardWorkspaceItem =
  | FolderBoardWorkspaceItem
  | SessionBoardWorkspaceItem
  | MarkdownBoardWorkspaceItem
  | AssetBoardWorkspaceItem;

export interface BuildBoardWorkspaceItemsParams {
  catalog: CatalogState;
  selectedFolderId: string | null;
  sessions: readonly SessionSummary[];
  relationIndex?: BoardSessionRelationIndex;
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

function metadataNumber(item: CatalogBoardItem, key: string): number | undefined {
  const value = item.metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function buildSessionPlaceholder(
  boardItem: CatalogBoardItem,
  catalog: CatalogState,
): SessionSummary {
  const assignment = catalog.sessions[boardItem.itemId];
  return {
    agentSessionId: boardItem.itemId,
    status: "unknown",
    eventCount: 0,
    sessionType: "claude",
    displayName: assignment?.displayName ?? undefined,
    folderId: assignment?.folderId ?? boardItem.folderId,
    createdAt: boardItem.createdAt,
    updatedAt: boardItem.updatedAt,
  };
}

function buildPositionedItems({
  catalog,
  selectedFolderId,
  sessions,
  relationIndex,
}: BuildBoardWorkspaceItemsParams): BoardWorkspaceItem[] {
  const folderById = new Map(catalog.folders.map((folder) => [folder.id, folder]));
  const relations = relationIndex ?? buildBoardSessionRelations({ catalog, sessions });
  const sessionById = relations.sessionById;
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
      const knownSession = sessionById.get(boardItem.itemId);
      if (
        knownSession &&
        shouldSuppressSessionInFolder(relations, knownSession.agentSessionId, selectedFolderId)
      ) {
        continue;
      }
      const session = knownSession ?? buildSessionPlaceholder(boardItem, catalog);
      items.push({
        type: "session",
        id: session.agentSessionId,
        boardItemId: boardItem.id,
        session,
        childStack: getSessionChildStack(relations, session.agentSessionId),
        parentRef: getSessionParentRef(relations, session.agentSessionId) ?? undefined,
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
        version: metadataNumber(boardItem, "version") ?? 1,
        x: boardItem.x,
        y: boardItem.y,
      });
      continue;
    }
    if (boardItem.itemType === "asset") {
      items.push({
        type: "asset",
        id: boardItem.itemId,
        boardItemId: boardItem.id,
        assetId: metadataText(boardItem, "assetId") || boardItem.itemId,
        fileName: metadataText(boardItem, "originalName") || "Untitled file",
        mimeType: metadataText(boardItem, "mimeType") || "application/octet-stream",
        byteSize: metadataNumber(boardItem, "byteSize") ?? 0,
        signedUrl: metadataText(boardItem, "signedUrl") || undefined,
        mediaWidth: metadataNumber(boardItem, "width"),
        mediaHeight: metadataNumber(boardItem, "height"),
        durationSeconds: metadataNumber(boardItem, "durationSeconds"),
        x: boardItem.x,
        y: boardItem.y,
        width: BOARD_TILE_WIDTH,
        height: BOARD_ASSET_TILE_HEIGHT,
      });
    }
  }

  return items.sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}

export function buildBoardWorkspaceItems({
  catalog,
  selectedFolderId,
  sessions,
  relationIndex,
}: BuildBoardWorkspaceItemsParams): BoardWorkspaceItem[] {
  const relations = relationIndex ?? buildBoardSessionRelations({ catalog, sessions });
  if (catalog.boardItems) {
    return buildPositionedItems({ catalog, selectedFolderId, sessions, relationIndex: relations });
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

  const visibleSessions = sessions.filter((session) =>
    !shouldSuppressSessionInFolder(relations, session.agentSessionId, selectedFolderId),
  );
  const sessionItems: SessionBoardWorkspaceItem[] = visibleSessions.map((session, index) => ({
    type: "session" as const,
    id: session.agentSessionId,
    boardItemId: `session:${session.agentSessionId}`,
    session,
    childStack: getSessionChildStack(relations, session.agentSessionId),
    parentRef: getSessionParentRef(relations, session.agentSessionId) ?? undefined,
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

export function getBoardItemWidth(item: BoardWorkspaceItem): number {
  return "width" in item ? item.width : BOARD_TILE_WIDTH;
}

export function getBoardItemHeight(item: BoardWorkspaceItem): number {
  return "height" in item ? item.height : BOARD_TILE_HEIGHT;
}

export function computeBoardCanvasSize(items: readonly BoardWorkspaceItem[]): { width: number; height: number } {
  const maxX = items.reduce((max, item) => Math.max(max, item.x + getBoardItemWidth(item)), 0);
  const maxY = items.reduce((max, item) => Math.max(max, item.y + getBoardItemHeight(item)), 0);
  return {
    width: maxX + BOARD_CANVAS_BUFFER,
    height: maxY + BOARD_CANVAS_BUFFER,
  };
}
