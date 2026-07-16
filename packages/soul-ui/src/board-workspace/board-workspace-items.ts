import type { BoardContainerRef, CatalogBoardItem, CatalogFolder, CatalogState, SessionSummary } from "../shared/types";
import {
  BOARD_FRAME_COLLAPSED_HEIGHT,
  BOARD_FRAME_COLLAPSED_WIDTH,
  getBoardFrameMetadata,
} from "./board-frames";
import {
  boardItemBelongsToContainer,
  isPrimarySessionBoardItem,
  sessionIdsOwnedByOtherBoardContainer,
} from "./board-container-visibility";
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
export const BOARD_RUNBOOK_TILE_WIDTH = 360;
export const BOARD_RUNBOOK_TILE_HEIGHT = 360;
export const BOARD_RUNBOOK_FIXED_CARD_WIDTH = 360;
export const BOARD_RUNBOOK_FIXED_CARD_HEIGHT = 520;
export const BOARD_RUNBOOK_FIXED_CARD_RECT = Object.freeze({
  x: 0,
  y: 0,
  width: BOARD_RUNBOOK_FIXED_CARD_WIDTH,
  height: BOARD_RUNBOOK_FIXED_CARD_HEIGHT,
});
export const BOARD_CUSTOM_VIEW_TILE_WIDTH = 280;
export const BOARD_CUSTOM_VIEW_TILE_HEIGHT = 160;
export const BOARD_CANVAS_BUFFER = 200;
export const BOARD_CANVAS_WIDTH = 100000;
export const BOARD_CANVAS_HEIGHT = 100000;
export const BOARD_CANVAS_ORIGIN_X = BOARD_CANVAS_WIDTH / 2;
export const BOARD_CANVAS_ORIGIN_Y = BOARD_CANVAS_HEIGHT / 2;

const BOARD_SPAWN_GAP = BOARD_GRID_SIZE * 2;
const BOARD_SPAWN_X_STEP = BOARD_TILE_WIDTH + BOARD_SPAWN_GAP;
const BOARD_SPAWN_Y_STEP = BOARD_TILE_HEIGHT + BOARD_GRID_SIZE;

export type GeneratedPlacementKind = "near-parent" | "inbox";

interface BoardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  generatedPlacementKind?: GeneratedPlacementKind;
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
  updatedAt?: string;
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
  updatedAt?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameBoardWorkspaceItem {
  type: "frame";
  id: string;
  boardItemId: string;
  folderId: string;
  title: string;
  collapsed: boolean;
  childItemIds: string[];
  childCount: number;
  hasRunningChild: boolean;
  updatedAt?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RunbookBoardWorkspaceItem {
  type: "runbook";
  id: string;
  boardItemId: string;
  runbookId: string;
  title: string;
  updatedAt?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CustomViewBoardWorkspaceItem {
  type: "custom_view";
  id: string;
  boardItemId: string;
  customViewId: string;
  title: string;
  preview: string;
  revision: number;
  updatedAt?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BoardWorkspaceItem =
  | FolderBoardWorkspaceItem
  | SessionBoardWorkspaceItem
  | MarkdownBoardWorkspaceItem
  | AssetBoardWorkspaceItem
  | FrameBoardWorkspaceItem
  | RunbookBoardWorkspaceItem
  | CustomViewBoardWorkspaceItem;

export interface BuildBoardWorkspaceItemsParams {
  catalog: CatalogState;
  selectedFolderId: string | null;
  boardContainer?: BoardContainerRef | null;
  sessions: readonly SessionSummary[];
  relationIndex?: BoardSessionRelationIndex;
  includeCollapsedFrameChildren?: boolean;
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
  return parseTimeMs(folder.updatedAt ?? folder.createdAt);
}

export function getBoardItemActivityMs(item: BoardWorkspaceItem): number {
  if (item.type === "session") return getSessionActivityMs(item.session);
  if (item.type === "folder") return getFolderActivityMs(item.folder);
  return parseTimeMs(item.updatedAt);
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

function buildAssignedSessionPlaceholder(
  sessionId: string,
  catalog: CatalogState,
): SessionSummary {
  const assignment = catalog.sessions[sessionId];
  return {
    agentSessionId: sessionId,
    status: "unknown",
    eventCount: 0,
    sessionType: "claude",
    displayName: assignment?.displayName ?? undefined,
    folderId: assignment?.folderId ?? null,
  };
}

function getSessionFolderAssignment(
  catalog: CatalogState,
  sessionId: string,
  session?: SessionSummary,
): string | null {
  const assignment = catalog.sessions[sessionId];
  if (assignment !== undefined) return assignment.folderId ?? null;
  if (session && Object.prototype.hasOwnProperty.call(session, "folderId")) {
    return session.folderId ?? null;
  }
  return null;
}

function sessionBelongsToSelectedFolder(
  catalog: CatalogState,
  sessionId: string,
  selectedFolderId: string | null,
  session?: SessionSummary,
): boolean {
  return getSessionFolderAssignment(catalog, sessionId, session) === selectedFolderId;
}

function folderBoardContainer(folderId: string | null): BoardContainerRef | null {
  return folderId ? { kind: "folder", id: folderId } : null;
}

function rectsOverlap(a: BoardRect, b: BoardRect): boolean {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
}

function itemRect(item: BoardWorkspaceItem): BoardRect {
  return {
    x: item.x,
    y: item.y,
    width: getBoardItemWidth(item),
    height: getBoardItemHeight(item),
  };
}

function positionCollides(
  items: readonly BoardWorkspaceItem[],
  position: { x: number; y: number },
  width = BOARD_TILE_WIDTH,
  height = BOARD_TILE_HEIGHT,
): boolean {
  const candidate = { x: position.x, y: position.y, width, height };
  return items.some((item) => rectsOverlap(candidate, itemRect(item)));
}

function findNearestOpenBoardPosition(
  items: readonly BoardWorkspaceItem[],
  preferred: { x: number; y: number },
): { x: number; y: number } {
  const snappedPreferred = snapBoardPosition(preferred.x, preferred.y);
  for (let ring = 0; ; ring += 1) {
    const candidates: { position: { x: number; y: number }; distance: number }[] = [];
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const position = snapBoardPosition(
          snappedPreferred.x + dx * BOARD_SPAWN_X_STEP,
          snappedPreferred.y + dy * BOARD_SPAWN_Y_STEP,
        );
        candidates.push({
          position,
          distance: (position.x - snappedPreferred.x) ** 2 + (position.y - snappedPreferred.y) ** 2,
        });
      }
    }
    candidates.sort((a, b) =>
      a.distance - b.distance ||
      Math.abs(a.position.y - snappedPreferred.y) - Math.abs(b.position.y - snappedPreferred.y) ||
      a.position.y - b.position.y ||
      a.position.x - b.position.x,
    );
    for (const candidate of candidates) {
      if (!positionCollides(items, candidate.position)) return candidate.position;
    }
  }
}

function resolveInboxRailX(items: readonly BoardWorkspaceItem[]): number {
  if (items.length === 0) return 0;
  const maxRight = items.reduce((max, item) => Math.max(max, item.x + getBoardItemWidth(item)), 0);
  return snapBoardCoordinate(maxRight + BOARD_SPAWN_GAP);
}

function resolveInboxRailStartY(items: readonly BoardWorkspaceItem[]): number {
  if (items.length === 0) return 0;
  return snapBoardCoordinate(Math.min(...items.map((item) => item.y)));
}

function findInboxRailPosition(
  items: readonly BoardWorkspaceItem[],
  railX: number,
  startY: number,
): { x: number; y: number } {
  for (let index = 0; ; index += 1) {
    const position = { x: railX, y: startY + index * BOARD_SPAWN_Y_STEP };
    if (!positionCollides(items, position)) return position;
  }
}

function findSessionBoardItem(
  items: readonly BoardWorkspaceItem[],
  sessionId: string,
): SessionBoardWorkspaceItem | undefined {
  return items.find((item): item is SessionBoardWorkspaceItem =>
    item.type === "session" && item.id === sessionId,
  );
}

function hasPersistedStackParent(
  relationIndex: BoardSessionRelationIndex,
  sessionId: string,
  selectedFolderId: string | null,
  persistedSessionIds: ReadonlySet<string>,
): boolean {
  if (!shouldSuppressSessionInFolder(relationIndex, sessionId, selectedFolderId)) return false;
  const parentSessionId = relationIndex.parentIdByChildId.get(sessionId);
  return Boolean(parentSessionId && persistedSessionIds.has(parentSessionId));
}

function hasVisibleStackParent(
  relationIndex: BoardSessionRelationIndex,
  sessionId: string,
  selectedFolderId: string | null,
  items: readonly BoardWorkspaceItem[],
): boolean {
  if (!shouldSuppressSessionInFolder(relationIndex, sessionId, selectedFolderId)) return false;
  const parentSessionId = relationIndex.parentIdByChildId.get(sessionId);
  const parentItem = parentSessionId ? findSessionBoardItem(items, parentSessionId) : undefined;
  return Boolean(parentItem && parentItem.generatedPlacementKind !== "inbox");
}

function refreshSessionChildStacks(
  relationIndex: BoardSessionRelationIndex,
  selectedFolderId: string | null,
  items: readonly BoardWorkspaceItem[],
): BoardWorkspaceItem[] {
  const visibleSameFolderChildIds = new Set(
    items
      .filter((item): item is SessionBoardWorkspaceItem => item.type === "session")
      .filter((item) => shouldSuppressSessionInFolder(relationIndex, item.session.agentSessionId, selectedFolderId))
      .map((item) => item.session.agentSessionId),
  );
  return items.map((item) =>
    item.type === "session"
      ? {
        ...item,
        childStack: getSessionChildStack(relationIndex, item.session.agentSessionId, {
          excludeSessionIds: visibleSameFolderChildIds,
        }),
      }
      : item,
  );
}

function filterPrimaryChildSessionsWithVisibleContainerParent(
  relationIndex: BoardSessionRelationIndex,
  boardItems: readonly CatalogBoardItem[] | undefined,
  boardContainer: BoardContainerRef | null | undefined,
  items: readonly BoardWorkspaceItem[],
  visibleItems: readonly BoardWorkspaceItem[],
): BoardWorkspaceItem[] {
  if (!boardItems || !boardContainer) return [...items];
  const primaryBoardItemIdBySessionId = new Map<string, string>();
  for (const boardItem of boardItems) {
    if (!isPrimarySessionBoardItem(boardItem)) continue;
    if (!boardItemBelongsToContainer(boardItem, boardContainer)) continue;
    primaryBoardItemIdBySessionId.set(boardItem.itemId, boardItem.id);
  }
  if (primaryBoardItemIdBySessionId.size === 0) return [...items];

  const visiblePrimarySessionIds = new Set(
    visibleItems
      .filter((item): item is SessionBoardWorkspaceItem => item.type === "session")
      .filter((item) => primaryBoardItemIdBySessionId.get(item.id) === item.boardItemId)
      .map((item) => item.id),
  );

  return items.filter((item) => {
    if (item.type !== "session") return true;
    if (primaryBoardItemIdBySessionId.get(item.id) !== item.boardItemId) return true;
    const parentSessionId = relationIndex.parentIdByChildId.get(item.id);
    return !parentSessionId || !visiblePrimarySessionIds.has(parentSessionId);
  });
}

function buildPositionedItems({
  catalog,
  selectedFolderId,
  boardContainer = folderBoardContainer(selectedFolderId),
  sessions,
  relationIndex,
  includeCollapsedFrameChildren = false,
}: BuildBoardWorkspaceItemsParams): BoardWorkspaceItem[] {
  const folderById = new Map(catalog.folders.map((folder) => [folder.id, folder]));
  const relations = relationIndex ?? buildBoardSessionRelations({ catalog, sessions });
  const sessionById = relations.sessionById;
  const selectedId = boardContainer?.kind === "folder" ? boardContainer.id : selectedFolderId ?? "";
  const isFolderBoard = boardContainer?.kind === "folder";
  const persistedSessionIds = new Set(
    (catalog.boardItems ?? [])
      .filter((item) =>
        item.itemType === "session" &&
        (boardContainer ? boardItemBelongsToContainer(item, boardContainer) : item.folderId === selectedId)
      )
      .map((item) => item.itemId),
  );
  const items: BoardWorkspaceItem[] = [];
  const suppressedSessionIds = new Set<string>();

  for (const boardItem of catalog.boardItems ?? []) {
    if (boardContainer) {
      if (!boardItemBelongsToContainer(boardItem, boardContainer)) continue;
    } else if (boardItem.folderId !== selectedId) {
      continue;
    }
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
      if (isFolderBoard && !sessionBelongsToSelectedFolder(catalog, boardItem.itemId, selectedFolderId, knownSession)) {
        continue;
      }
      if (isFolderBoard && hasPersistedStackParent(relations, boardItem.itemId, selectedFolderId, persistedSessionIds)) {
        suppressedSessionIds.add(boardItem.itemId);
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
        updatedAt: boardItem.updatedAt,
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
        updatedAt: boardItem.updatedAt,
        x: boardItem.x,
        y: boardItem.y,
        width: BOARD_TILE_WIDTH,
        height: BOARD_ASSET_TILE_HEIGHT,
      });
      continue;
    }
    if (boardItem.itemType === "frame") {
      const metadata = getBoardFrameMetadata(boardItem);
      items.push({
        type: "frame",
        id: boardItem.itemId,
        boardItemId: boardItem.id,
        folderId: boardItem.folderId,
        title: metadata.title,
        collapsed: metadata.collapsed,
        childItemIds: metadata.childItemIds,
        childCount: metadata.childItemIds.length,
        hasRunningChild: false,
        updatedAt: boardItem.updatedAt,
        x: boardItem.x,
        y: boardItem.y,
        width: metadata.width,
        height: metadata.height,
      });
      continue;
    }
    if (boardItem.itemType === "runbook") {
      items.push({
        type: "runbook",
        id: boardItem.itemId,
        boardItemId: boardItem.id,
        runbookId: boardItem.itemId,
        title: metadataText(boardItem, "title") || "Runbook",
        updatedAt: boardItem.updatedAt,
        x: boardItem.x,
        y: boardItem.y,
        width: BOARD_RUNBOOK_TILE_WIDTH,
        height: BOARD_RUNBOOK_TILE_HEIGHT,
      });
      continue;
    }
    if (boardItem.itemType === "custom_view") {
      items.push({
        type: "custom_view",
        id: boardItem.itemId,
        boardItemId: boardItem.id,
        customViewId: boardItem.itemId,
        title: metadataText(boardItem, "title") || "Custom view",
        preview: metadataText(boardItem, "preview"),
        revision: metadataNumber(boardItem, "revision") ?? 1,
        updatedAt: boardItem.updatedAt,
        x: boardItem.x,
        y: boardItem.y,
        width: BOARD_CUSTOM_VIEW_TILE_WIDTH,
        height: BOARD_CUSTOM_VIEW_TILE_HEIGHT,
      });
    }
  }

  if (!isFolderBoard) {
    const summarized = applyFrameSummaries(items)
      .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
    const visibleItems = getVisibleBoardWorkspaceItems(summarized);
    const filtered = filterPrimaryChildSessionsWithVisibleContainerParent(
      relations,
      catalog.boardItems,
      boardContainer,
      summarized,
      visibleItems,
    );
    return includeCollapsedFrameChildren ? filtered : getVisibleBoardWorkspaceItems(filtered);
  }

  const existingSessionIds = new Set(
    items.filter((item): item is SessionBoardWorkspaceItem => item.type === "session").map((item) => item.id),
  );

  // 현재 폴더 컨테이너가 아닌 다른 primary placement가 이미 소유한 세션은
  // 폴더 보드에서 합성하지 않는다. runbook뿐 아니라 하위 folder 컨테이너도
  // 같은 소유권 경계로 취급한다.
  const sessionIdsOwnedByOtherContainer = sessionIdsOwnedByOtherBoardContainer(
    catalog.boardItems,
    boardContainer,
    selectedFolderId,
  );

  const sessionCandidates = new Map<string, SessionSummary>();
  for (const session of relations.sessions) {
    if (sessionIdsOwnedByOtherContainer.has(session.agentSessionId)) continue;
    const assignedFolderId = getSessionFolderAssignment(catalog, session.agentSessionId, session);
    if (assignedFolderId !== selectedFolderId) continue;
    sessionCandidates.set(session.agentSessionId, { ...session, folderId: assignedFolderId });
  }
  for (const [sessionId, assignment] of Object.entries(catalog.sessions)) {
    if (sessionIdsOwnedByOtherContainer.has(sessionId)) continue;
    if ((assignment.folderId ?? null) !== selectedFolderId || sessionCandidates.has(sessionId)) continue;
    sessionCandidates.set(
      sessionId,
      relations.sessionById.get(sessionId) ?? buildAssignedSessionPlaceholder(sessionId, catalog),
    );
  }

  const inboxRailX = resolveInboxRailX(items);
  const inboxRailStartY = resolveInboxRailStartY(items);
  const generatedPlacementKindBySessionId = new Map<string, GeneratedPlacementKind>();
  const placingSessionIds = new Set<string>();

  const placeGeneratedSession = (sessionId: string) => {
    if (existingSessionIds.has(sessionId)) return;
    const session = sessionCandidates.get(sessionId);
    if (!session || placingSessionIds.has(sessionId)) return;
    placingSessionIds.add(sessionId);

    const parentSessionId = relations.parentIdByChildId.get(sessionId);
    if (parentSessionId && sessionCandidates.has(parentSessionId) && !existingSessionIds.has(parentSessionId)) {
      placeGeneratedSession(parentSessionId);
    }
    if (
      (parentSessionId && suppressedSessionIds.has(parentSessionId)) ||
      hasVisibleStackParent(relations, sessionId, selectedFolderId, items)
    ) {
      suppressedSessionIds.add(sessionId);
      placingSessionIds.delete(sessionId);
      return;
    }

    const parentItem = parentSessionId ? findSessionBoardItem(items, parentSessionId) : undefined;
    const parentPlacementKind = parentSessionId ? generatedPlacementKindBySessionId.get(parentSessionId) : undefined;
    const shouldSpawnBesideParent = Boolean(parentItem && parentPlacementKind !== "inbox");
    const position = parentItem && shouldSpawnBesideParent
      ? findNearestOpenBoardPosition(items, {
        x: parentItem.x + getBoardItemWidth(parentItem) + BOARD_SPAWN_GAP,
        y: parentItem.y,
      })
      : findInboxRailPosition(items, inboxRailX, inboxRailStartY);
    existingSessionIds.add(session.agentSessionId);
    items.push({
      type: "session",
      id: session.agentSessionId,
      boardItemId: `session:${session.agentSessionId}`,
      session,
      childStack: getSessionChildStack(relations, session.agentSessionId),
      parentRef: getSessionParentRef(relations, session.agentSessionId) ?? undefined,
      generatedPlacementKind: shouldSpawnBesideParent ? "near-parent" : "inbox",
      x: position.x,
      y: position.y,
    });
    generatedPlacementKindBySessionId.set(sessionId, shouldSpawnBesideParent ? "near-parent" : "inbox");
    placingSessionIds.delete(sessionId);
  };

  for (const session of sessionCandidates.values()) {
    placeGeneratedSession(session.agentSessionId);
  }

  const summarized = applyFrameSummaries(refreshSessionChildStacks(relations, selectedFolderId, items))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  return includeCollapsedFrameChildren ? summarized : getVisibleBoardWorkspaceItems(summarized);
}

function applyFrameSummaries(items: readonly BoardWorkspaceItem[]): BoardWorkspaceItem[] {
  const itemById = new Map(items.map((item) => [item.boardItemId, item]));
  return items.map((item) => {
    if (item.type !== "frame") return item;
    const children = item.childItemIds
      .map((childId) => itemById.get(childId))
      .filter((child): child is BoardWorkspaceItem => Boolean(child));
    return {
      ...item,
      childCount: item.childItemIds.length,
      hasRunningChild: children.some((child) =>
        child.type === "session" &&
        (child.session.status === "running" || child.childStack?.status === "running"),
      ),
    };
  });
}

export function getVisibleBoardWorkspaceItems(items: readonly BoardWorkspaceItem[]): BoardWorkspaceItem[] {
  const hiddenChildIds = new Set<string>();
  for (const item of items) {
    if (item.type !== "frame" || !item.collapsed) continue;
    for (const childId of item.childItemIds) hiddenChildIds.add(childId);
  }
  return items.filter((item) => !hiddenChildIds.has(item.boardItemId));
}

export function buildBoardWorkspaceItems({
  catalog,
  selectedFolderId,
  boardContainer = folderBoardContainer(selectedFolderId),
  sessions,
  relationIndex,
  includeCollapsedFrameChildren,
}: BuildBoardWorkspaceItemsParams): BoardWorkspaceItem[] {
  const relations = relationIndex ?? buildBoardSessionRelations({ catalog, sessions });
  if (catalog.boardItems) {
    return buildPositionedItems({
      catalog,
      selectedFolderId,
      boardContainer,
      sessions,
      relationIndex: relations,
      includeCollapsedFrameChildren,
    });
  }

  if (boardContainer?.kind !== "folder") {
    return [];
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
    sessionBelongsToSelectedFolder(catalog, session.agentSessionId, selectedFolderId, session) &&
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
  if (item.type === "frame" && item.collapsed) return BOARD_FRAME_COLLAPSED_WIDTH;
  return "width" in item ? item.width : BOARD_TILE_WIDTH;
}

export function getBoardItemHeight(item: BoardWorkspaceItem): number {
  if (item.type === "frame" && item.collapsed) return BOARD_FRAME_COLLAPSED_HEIGHT;
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
