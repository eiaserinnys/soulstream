// Size exception: this legacy coordinator still owns board sync, drag, upload,
// creation, and view wiring. New frame domain logic is kept in board-frames.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import type { BoardContainerRef, CatalogBoardItem, CatalogState, SessionSummary } from "../shared/types";
import { useRunbookStore, type RunbookSnapshot } from "../stores/runbook-store";
import { FolderDialog } from "../components/FolderDialog";
import { runGuardedLoadMore } from "../components/load-more-guard";
import { toastManager } from "../components/ui/toast";
import { useIsMobile } from "../hooks/use-mobile";
import { cn } from "../lib/cn";
import { applyCatalogDisplayNames } from "../hooks/session-stream-helpers";
import { BoardWorkspaceCanvasContent } from "./BoardWorkspaceCanvasContent";
import {
  boardToCanvasStyle,
  BOARD_ASSET_TILE_HEIGHT,
  BOARD_TILE_HEIGHT,
  BOARD_TILE_WIDTH,
  buildBoardWorkspaceItems,
  getVisibleBoardWorkspaceItems,
  snapBoardPosition,
  type AssetBoardWorkspaceItem,
  type BoardWorkspaceItem,
  type FrameBoardWorkspaceItem,
} from "./board-workspace-items";
import {
  applyBoardItemPositionUpdates,
  buildFrameMembershipUpdates,
  createFrameBoardItem,
  expandFramePositionUpdates,
  frameItemToCatalogBoardItem,
  getFrameCreationRect,
} from "./board-frames";
import { isBoardTileTarget } from "./board-workspace-dom";
import { getFolderBreadcrumbs } from "./board-workspace-helpers";
import { BoardWorkspaceHeader } from "./BoardWorkspaceHeader";
import { declutterBoardItems } from "./board-declutter";
import {
  BoardWorkspaceContextMenus,
  type BoardCardContextMenuState,
  type BoardContextMenuState,
  type RunbookMoveTarget,
} from "./BoardWorkspaceContextMenus";
import { useBoardYjsRuntime } from "./board-yjs-client";
import { BoardWorkspaceMinimap } from "./BoardWorkspaceMinimap";
import { BoardWorkspaceZoomControls } from "./BoardWorkspaceZoomControls";
import type { BoardItemPositionUpdate } from "./board-selection";
import { useBoardSelectionState } from "./useBoardSelectionState";
import { useBoardCanvasViewport } from "./useBoardCanvasViewport";
import { centerBoardPointInScroller } from "./board-viewport";
import {
  buildBoardSessionRelations,
  type DirectChildPortalItem,
} from "./board-session-relations";
import { findOpenBoardPositionInViewport, getFallbackBoardSpawnViewport } from "./board-spawn";
import { findEmptyPlacement } from "./findEmptyPlacement";
import { useBoardChildStackState } from "./useBoardChildStackState";
import type { BoardWorkspaceViewProps } from "./BoardWorkspaceView.types";
export type { BoardWorkspaceViewProps, CreateMarkdownDocumentInput, CreateMarkdownDocumentResult } from "./BoardWorkspaceView.types";
const EMPTY_SESSIONS: SessionSummary[] = [];

function boardContainerKey(container: BoardContainerRef | null): string | null {
  return container ? `${container.kind}:${container.id}` : null;
}

function folderBoardContainer(folderId: string | null): BoardContainerRef | null {
  return folderId ? { kind: "folder", id: folderId } : null;
}

function boardItemBelongsToContainer(
  item: CatalogBoardItem,
  container: BoardContainerRef,
): boolean {
  const itemContainerKind = item.containerKind ?? "folder";
  const itemContainerId = item.containerId ?? item.folderId;
  return itemContainerKind === container.kind && itemContainerId === container.id;
}

function boardItemsUrl(container: BoardContainerRef): string {
  if (container.kind === "folder") {
    return `/api/board-items?folder_id=${encodeURIComponent(container.id)}`;
  }
  return `/api/board-items?container_kind=${encodeURIComponent(container.kind)}&container_id=${encodeURIComponent(container.id)}`;
}

function runbookProgress(snapshot: RunbookSnapshot | null): { completed: number; total: number } {
  let completed = 0;
  let total = 0;
  for (const item of snapshot?.items ?? []) {
    if (item.archived || item.status === "cancelled") continue;
    total += 1;
    if (item.status === "completed") completed += 1;
  }
  return { completed, total };
}

function getBoardItemCenter(item: BoardWorkspaceItem): { x: number; y: number } {
  const width = "width" in item ? item.width : BOARD_TILE_WIDTH;
  const height = "height" in item ? item.height : BOARD_TILE_HEIGHT;
  return { x: item.x + width / 2, y: item.y + height / 2 };
}

function createBoardMoveIdempotencyKey(
  boardItemId: string,
  target: BoardContainerRef,
): string {
  const randomPart = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `board-item-move:${boardItemId}:${target.kind}:${target.id}:${randomPart}`;
}

export function resolveEffectiveBoardCatalog(params: {
  catalog: CatalogState | null;
  selectedFolderId: string | null;
  boardContainer?: BoardContainerRef | null;
  yjsBoardItemsForSelectedFolder: CatalogBoardItem[] | null;
  isYjsLoading: boolean;
  hasYjsSynced: boolean;
  assetSignedUrls: Record<string, string>;
}): CatalogState | null {
  const {
    catalog,
    selectedFolderId,
    boardContainer = folderBoardContainer(selectedFolderId),
    yjsBoardItemsForSelectedFolder,
    isYjsLoading,
    hasYjsSynced,
    assetSignedUrls,
  } = params;
  if (!catalog || !yjsBoardItemsForSelectedFolder || isYjsLoading || !hasYjsSynced) {
    if (!catalog?.boardItems || !boardContainer || boardContainer.kind === "folder") return catalog;
    return {
      ...catalog,
      boardItems: catalog.boardItems.filter((item) => boardItemBelongsToContainer(item, boardContainer)),
    };
  }
  const otherFolderBoardItems = (catalog.boardItems ?? []).filter((item) =>
    boardContainer ? !boardItemBelongsToContainer(item, boardContainer) : item.folderId !== selectedFolderId
  );
  return {
    ...catalog,
    boardItems: [...otherFolderBoardItems, ...yjsBoardItemsForSelectedFolder.map((item) => {
      if (item.itemType !== "asset") return item;
      const signedUrl = assetSignedUrls[item.id];
      if (!signedUrl) return item;
      return {
        ...item,
        metadata: {
          ...(item.metadata ?? {}),
          signedUrl,
        },
      };
    })],
  };
}

function boardWorkspaceItemToCatalogBoardItem(
  item: BoardWorkspaceItem,
  container: BoardContainerRef | null,
  resolvedFolderId: string | null,
  x: number,
  y: number,
): CatalogBoardItem | null {
  if (!container || !resolvedFolderId) return null;
  const withContainer = (boardItem: CatalogBoardItem): CatalogBoardItem => ({
    ...boardItem,
    folderId: resolvedFolderId,
    containerKind: container.kind,
    containerId: container.id,
  });
  if (item.type === "session") {
    return withContainer({
      id: item.boardItemId,
      folderId: resolvedFolderId,
      itemType: "session",
      itemId: item.session.agentSessionId,
      x,
      y,
    });
  }
  if (item.type === "folder") {
    return withContainer({
      id: item.boardItemId,
      folderId: resolvedFolderId,
      itemType: "subfolder",
      itemId: item.folder.id,
      x,
      y,
    });
  }
  if (item.type === "frame") {
    return withContainer(frameItemToCatalogBoardItem(item, { x, y }));
  }
  if (item.type === "runbook") {
    return withContainer({
      id: item.boardItemId,
      folderId: resolvedFolderId,
      itemType: "runbook",
      itemId: item.runbookId,
      x,
      y,
      metadata: {
        title: item.title,
      },
    });
  }
  if (item.type === "custom_view") {
    return withContainer({
      id: item.boardItemId,
      folderId: resolvedFolderId,
      itemType: "custom_view",
      itemId: item.customViewId,
      x,
      y,
      metadata: {
        title: item.title,
        preview: item.preview,
        revision: item.revision,
      },
    });
  }
  return null;
}

function fileListFromDataTransfer(dataTransfer: DataTransfer | null): File[] {
  return Array.from(dataTransfer?.files ?? []).filter((file) => file.size >= 0);
}

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

function createUploadPlaceholderId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `upload:${crypto.randomUUID()}`;
  return `upload:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function createFrameId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `frame:${crypto.randomUUID()}`;
  return `frame:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function createObjectUrl(file: File): string | undefined {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return undefined;
  return URL.createObjectURL(file);
}

function revokeObjectUrl(url: string | undefined): void {
  if (!url || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(url);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Upload failed";
}

async function withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function extractMediaMetadata(
  file: File,
  sourceUrl: string | undefined,
): Promise<{ width?: number; height?: number; durationSeconds?: number }> {
  if (!sourceUrl || typeof document === "undefined") return {};
  if (file.type.startsWith("image/")) {
    return await withTimeout(new Promise<{ width?: number; height?: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({});
      img.src = sourceUrl;
    }), {});
  }
  if (file.type.startsWith("audio/") || file.type.startsWith("video/")) {
    return await withTimeout(new Promise<{ width?: number; height?: number; durationSeconds?: number }>((resolve) => {
      const element = file.type.startsWith("video/")
        ? document.createElement("video")
        : document.createElement("audio");
      element.preload = "metadata";
      element.onloadedmetadata = () => resolve({
        ...(element instanceof HTMLVideoElement ? { width: element.videoWidth, height: element.videoHeight } : {}),
        durationSeconds: Number.isFinite(element.duration) ? element.duration : undefined,
      });
      element.onerror = () => resolve({});
      element.src = sourceUrl;
    }), {});
  }
  return {};
}
export function BoardWorkspaceView({
  sessions = EMPTY_SESSIONS,
  onMoveSessions,
  onRenameSession,
  onDeleteSessions,
  onContinueSession,
  getContinueSessionDisabledReason,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onUpdateFolderSettings,
  onUpdateBoardItemPosition: _onUpdateBoardItemPosition,
  onMoveBoardItemToContainer,
  onCreateMarkdownDocument: _onCreateMarkdownDocument,
  onUploadBoardAsset,
  onLoadMore,
  hasMore,
  workspaceViewMode,
  onWorkspaceViewModeChange,
}: BoardWorkspaceViewProps) {
  const catalog = useDashboardStore((s) => s.catalog);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const setActiveSessionSummary = useDashboardStore((s) => s.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);
  const setActiveBoardDocument = useDashboardStore((s) => s.setActiveBoardDocument);
  const setActiveCustomView = useDashboardStore((s) => s.setActiveCustomView);
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);
  const toggleSessionSelection = useDashboardStore((s) => s.toggleSessionSelection);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const activeBoardDocumentId = useDashboardStore((s) => s.activeBoardDocumentId);
  const focusedBoardItem = useDashboardStore((s) => s.focusedBoardItem);
  const clearFocusedBoardItem = useDashboardStore((s) => s.clearFocusedBoardItem);
  const addBoardItem = useDashboardStore((s) => s.addBoardItem);
  const activeBoardContainer = useDashboardStore((s) => s.activeBoardContainer);
  const openRunbookBoard = useDashboardStore((s) => s.openRunbookBoard);
  const setBoardItemsForContainer = useDashboardStore((s) => s.setBoardItemsForContainer);
  const updateBoardItemPosition = useDashboardStore((s) => s.updateBoardItemPosition);
  const removeBoardItem = useDashboardStore((s) => s.removeBoardItem);
  const isMobile = useIsMobile();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createFolderPosition, setCreateFolderPosition] = useState<{ x: number; y: number } | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<BoardContextMenuState | null>(null);
  const [cardContextMenu, setCardContextMenu] = useState<BoardCardContextMenuState | null>(null);
  const [assetPlaceholders, setAssetPlaceholders] = useState<AssetBoardWorkspaceItem[]>([]);
  const [assetSignedUrls, setAssetSignedUrls] = useState<Record<string, string>>({});
  const [declutterUndoUpdates, setDeclutterUndoUpdates] = useState<BoardItemPositionUpdate[]>([]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const assetObjectUrlsRef = useRef(new Set<string>());
  const loadMoreGateRef = useRef(false);
  const previousBoardSyncStatusRef = useRef<string | null>(null);
  const {
    selectedBoardItemIds,
    primarySelectedBoardItemId,
    selectBoardItems,
    selectSingleBoardItem,
    clearBoardSelection,
    toggleBoardItemSelection,
    raiseBoardItems,
    getBoardItemZIndex,
  } = useBoardSelectionState();
  const folders = catalog?.folders ?? [];
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const boardContainer = useMemo(
    () => activeBoardContainer ?? folderBoardContainer(selectedFolderId),
    [activeBoardContainer, selectedFolderId],
  );
  const activeBoardContainerKey = boardContainerKey(boardContainer);
  const resolvedBoardFolderId = boardContainer
    ? boardContainer.kind === "folder"
      ? boardContainer.id
      : selectedFolderId ?? boardContainer.id
    : null;
  const isRunbookBoard = boardContainer?.kind === "runbook";
  const runbookId = isRunbookBoard ? boardContainer.id : null;
  const runbookProjection = useRunbookStore((s) => (runbookId ? s.byId[runbookId] : undefined));
  const loadRunbook = useRunbookStore((s) => s.loadRunbook);
  const runbookSnapshot = runbookProjection?.snapshot ?? null;
  const runbookBoardProgress = useMemo(
    () => runbookProgress(runbookSnapshot),
    [runbookSnapshot],
  );
  const displaySessions = useMemo(() => applyCatalogDisplayNames(sessions, catalog), [sessions, catalog]);
  const boardSync = useBoardYjsRuntime({
    container: boardContainer,
    resolvedFolderId: resolvedBoardFolderId,
    catalog,
    selectionItemId: primarySelectedBoardItemId,
  });

  useEffect(() => {
    if (!runbookId) return;
    const controller = new AbortController();
    void loadRunbook(runbookId, { signal: controller.signal });
    return () => {
      controller.abort();
    };
  }, [loadRunbook, runbookId]);

  const rememberAssetSignedUrls = useCallback((items: CatalogBoardItem[]) => {
    setAssetSignedUrls((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of items) {
        if (item.itemType !== "asset") continue;
        const signedUrl = item.metadata?.signedUrl;
        if (typeof signedUrl !== "string" || !signedUrl) continue;
        if (next[item.id] === signedUrl) continue;
        next[item.id] = signedUrl;
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);

  useEffect(() => {
    if (!boardContainer) return;
    const controller = new AbortController();
    fetch(boardItemsUrl(boardContainer), {
      signal: controller.signal,
    })
      .then((r) => {
        if (r.ok) return r.json();
        throw new Error("board items fetch failed");
      })
      .then((data) => {
        if (Array.isArray(data?.boardItems)) {
          rememberAssetSignedUrls(data.boardItems);
          setBoardItemsForContainer(boardContainer, data.boardItems);
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => {
      controller.abort();
    };
  }, [activeBoardContainerKey, boardContainer, rememberAssetSignedUrls, setBoardItemsForContainer]);

  useEffect(() => {
    rememberAssetSignedUrls(catalog?.boardItems ?? []);
  }, [catalog?.boardItems, rememberAssetSignedUrls]);

  const yjsBoardItemsForSelectedFolder =
    boardSync.runtime?.containerKey === activeBoardContainerKey ? boardSync.boardItems : null;
  const effectiveCatalog = useMemo(() => resolveEffectiveBoardCatalog({
    catalog,
    selectedFolderId,
    boardContainer,
    yjsBoardItemsForSelectedFolder,
    isYjsLoading: boardSync.isLoading,
    hasYjsSynced: boardSync.hasSynced,
    assetSignedUrls,
  }), [assetSignedUrls, boardContainer, boardSync.hasSynced, boardSync.isLoading, catalog, selectedFolderId, yjsBoardItemsForSelectedFolder]);
  const relationIndex = useMemo(() => {
    if (!effectiveCatalog) return null;
    return buildBoardSessionRelations({
      catalog: effectiveCatalog,
      sessions: displaySessions,
    });
  }, [displaySessions, effectiveCatalog]);
  const remoteSelectionByItemId = useMemo(() => {
    const selections = new Map<string, string>();
    for (const selection of boardSync.remoteSelections) {
      selections.set(selection.itemId, selection.color);
    }
    return selections;
  }, [boardSync.remoteSelections]);
  const breadcrumbs = useMemo(
    () => getFolderBreadcrumbs(folders, selectedFolderId),
    [folders, selectedFolderId],
  );

  const allPersistedBoardItems = useMemo(() => {
    if (!effectiveCatalog) return [];
    return buildBoardWorkspaceItems({
      catalog: effectiveCatalog,
      selectedFolderId,
      boardContainer,
      sessions: displaySessions,
      ...(relationIndex ? { relationIndex } : {}),
      includeCollapsedFrameChildren: true,
    });
  }, [boardContainer, effectiveCatalog, selectedFolderId, displaySessions, relationIndex]);
  const persistedBoardItems = useMemo(
    () => getVisibleBoardWorkspaceItems(allPersistedBoardItems),
    [allPersistedBoardItems],
  );
  const boardItems = useMemo(
    () => [...persistedBoardItems, ...assetPlaceholders].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id)),
    [assetPlaceholders, persistedBoardItems],
  );
  const runbookMoveTargets = useMemo<RunbookMoveTarget[]>(() => {
    if (!effectiveCatalog || !resolvedBoardFolderId) return [];
    return (effectiveCatalog.boardItems ?? [])
      .filter((item) =>
        item.itemType === "runbook" &&
        item.folderId === resolvedBoardFolderId &&
        (item.containerKind ?? "folder") === "folder" &&
        (item.containerId ?? item.folderId) === resolvedBoardFolderId
      )
      .map((item) => ({
        id: item.itemId,
        title: typeof item.metadata?.title === "string" && item.metadata.title.trim()
          ? item.metadata.title
          : item.itemId,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [effectiveCatalog, resolvedBoardFolderId]);
  const allBoardItems = useMemo(
    () => [...allPersistedBoardItems, ...assetPlaceholders].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id)),
    [allPersistedBoardItems, assetPlaceholders],
  );
  const yjsUpdateBoardItemPosition = useCallback((boardItemId: string, x: number, y: number) => {
    const existingItem = allBoardItems.find((item) => item.boardItemId === boardItemId);
    const boardItem = existingItem
      ? boardWorkspaceItemToCatalogBoardItem(existingItem, boardContainer, resolvedBoardFolderId, x, y)
      : null;
    if (boardItem) {
      boardSync.runtime?.upsertBoardItem(boardItem);
      addBoardItem(boardItem);
    } else {
      boardSync.runtime?.updateBoardItemPosition(boardItemId, x, y);
    }
    updateBoardItemPosition(boardItemId, x, y);
  }, [addBoardItem, allBoardItems, boardContainer, boardSync.runtime, resolvedBoardFolderId, updateBoardItemPosition]);
  const childStack = useBoardChildStackState({
    boardItems,
    relationIndex,
    selectedFolderId,
    selectFolder,
  });
  const yjsUpdateBoardItemPositions = useCallback((updates: BoardItemPositionUpdate[]) => {
    const expandedUpdates = expandFramePositionUpdates(allBoardItems, updates);
    for (const update of expandedUpdates) {
      yjsUpdateBoardItemPosition(update.boardItemId, update.x, update.y);
    }
    const nextItems = applyBoardItemPositionUpdates(allBoardItems, expandedUpdates);
    const frameUpdates = buildFrameMembershipUpdates(nextItems, updates.map((update) => update.boardItemId));
    for (const frameUpdate of frameUpdates) {
      boardSync.runtime?.upsertBoardItem(frameUpdate);
      addBoardItem(frameUpdate);
    }
  }, [addBoardItem, allBoardItems, boardSync.runtime, yjsUpdateBoardItemPosition]);
  const handleDeclutterBoard = useCallback(() => {
    const declutterUpdates = declutterBoardItems(boardItems);
    if (declutterUpdates.length === 0) return;
    const expandedUpdates = expandFramePositionUpdates(allBoardItems, declutterUpdates);
    const currentById = new Map(allBoardItems.map((item) => [item.boardItemId, item]));
    setDeclutterUndoUpdates(expandedUpdates.flatMap((update) => {
      const current = currentById.get(update.boardItemId);
      if (!current || (current.x === update.x && current.y === update.y)) return [];
      return [{ boardItemId: current.boardItemId, x: current.x, y: current.y }];
    }));
    yjsUpdateBoardItemPositions(declutterUpdates);
  }, [allBoardItems, boardItems, yjsUpdateBoardItemPositions]);
  const handleUndoDeclutter = useCallback(() => {
    if (declutterUndoUpdates.length === 0) return;
    yjsUpdateBoardItemPositions(declutterUndoUpdates);
    setDeclutterUndoUpdates([]);
  }, [declutterUndoUpdates, yjsUpdateBoardItemPositions]);

  useEffect(() => {
    setDeclutterUndoUpdates([]);
  }, [activeBoardContainerKey]);
  const {
    scrollRef,
    zoom,
    viewport,
    minimapCollapsed,
    setMinimapCollapsed,
    resolveBoardPoint,
    handleMinimapMoveViewport,
    handleZoomIn,
    handleZoomOut,
    dragPreviewByItemId,
    planeStyle,
    canvasStyle,
    dragPreviews,
    marqueeRect,
    handleCanvasPointerDown,
    handleTilePointerDown,
    isPanning,
    isSpaceDown,
    shouldSuppressTileClick,
  } = useBoardCanvasViewport({
    selectedFolderId: activeBoardContainerKey,
    boardItems,
    selectedBoardItemIds,
    selectBoardItems,
    toggleBoardItemSelection,
    clearBoardSelection,
    raiseBoardItems,
    updateBoardItemPositions: yjsUpdateBoardItemPositions,
  });

  useEffect(() => {
    if (!focusedBoardItem) return;
    if (focusedBoardItem.folderId !== selectedFolderId) return;
    const item = boardItems.find((candidate) => candidate.boardItemId === focusedBoardItem.boardItemId);
    const scroller = scrollRef.current;
    if (!item || !scroller) return;
    selectSingleBoardItem(item.boardItemId);
    raiseBoardItems([item.boardItemId]);
    centerBoardPointInScroller(scroller, getBoardItemCenter(item), zoom);
    clearFocusedBoardItem(focusedBoardItem.requestId);
  }, [
    boardItems,
    clearFocusedBoardItem,
    focusedBoardItem,
    raiseBoardItems,
    scrollRef,
    selectSingleBoardItem,
    selectedFolderId,
    zoom,
  ]);

  const resolveSpawnPosition = useCallback(() => {
    const spawnViewport = viewport.width > 0 && viewport.height > 0
      ? viewport
      : getFallbackBoardSpawnViewport(zoom);
    return findOpenBoardPositionInViewport(boardItems, {
      viewport: spawnViewport,
      zoom,
    });
  }, [boardItems, viewport, zoom]);

  const handleCreateFolder = async (name: string) => {
    if (!selectedFolderId || boardContainer?.kind !== "folder") return;
    const position = createFolderPosition ? snapBoardPosition(createFolderPosition.x, createFolderPosition.y) : null;
    const created = await onCreateFolder?.(name.trim(), selectedFolderId);
    if (created && position && selectedFolderId) {
      const boardItem: CatalogBoardItem = {
        id: `subfolder:${created.id}`,
        folderId: selectedFolderId,
        containerKind: "folder",
        containerId: selectedFolderId,
        itemType: "subfolder",
        itemId: created.id,
        x: position.x,
        y: position.y,
      };
      boardSync.runtime?.upsertBoardItem(boardItem);
      addBoardItem(boardItem);
    }
    setCreateFolderPosition(null);
    setCreateDialogOpen(false);
  };

  const openCreateFolderDialog = (position?: { x: number; y: number }) => {
    if (boardContainer?.kind !== "folder") return;
    const resolved = position ?? resolveSpawnPosition();
    setCreateFolderPosition(snapBoardPosition(resolved.x, resolved.y));
    setCreateDialogOpen(true);
    setContextMenu(null);
    setNewMenuOpen(false);
  };

  const createMarkdownAt = useCallback(async (position?: { x: number; y: number }) => {
    if (!resolvedBoardFolderId || !boardContainer || !boardSync.runtime) return;
    const resolved = position ?? resolveSpawnPosition();
    const snapped = snapBoardPosition(resolved.x, resolved.y);
    try {
      const result = boardSync.runtime.createMarkdownDocument({
        title: "Untitled document",
        body: "",
        x: snapped.x,
        y: snapped.y,
      });
      addBoardItem(result.boardItem);
      setActiveBoardDocument(result.document.id);
      if (isMobile) setActiveTab("chat");
      setNewMenuOpen(false);
      setContextMenu(null);
    } catch (err) {
      console.error("Markdown document creation failed:", err);
    }
  }, [addBoardItem, boardContainer, boardSync.runtime, isMobile, resolveSpawnPosition, resolvedBoardFolderId, setActiveBoardDocument, setActiveTab]);

  const createFrameAt = useCallback((position?: { x: number; y: number }) => {
    if (!selectedFolderId || boardContainer?.kind !== "folder" || !boardSync.runtime) return;
    const resolved = position ?? resolveSpawnPosition();
    const snapped = snapBoardPosition(resolved.x, resolved.y);
    const selectedItems = boardItems.filter((item) =>
      selectedBoardItemIds.has(item.boardItemId) && item.type !== "frame"
    );
    const rect = getFrameCreationRect(selectedItems, snapped);
    const framePosition = snapBoardPosition(rect.x, rect.y);
    const boardItem = createFrameBoardItem({
      folderId: selectedFolderId,
      frameId: createFrameId(),
      x: framePosition.x,
      y: framePosition.y,
      width: rect.width,
      height: rect.height,
      childItemIds: rect.childItemIds,
    });
    boardSync.runtime.upsertBoardItem(boardItem);
    addBoardItem(boardItem);
    selectSingleBoardItem(boardItem.id);
    raiseBoardItems([boardItem.id]);
    setNewMenuOpen(false);
    setContextMenu(null);
  }, [
    addBoardItem,
    boardContainer?.kind,
    boardItems,
    boardSync.runtime,
    raiseBoardItems,
    resolveSpawnPosition,
    selectSingleBoardItem,
    selectedBoardItemIds,
    selectedFolderId,
  ]);

  const upsertFrame = useCallback((
    frame: FrameBoardWorkspaceItem,
    overrides: Parameters<typeof frameItemToCatalogBoardItem>[1],
  ) => {
    const boardItem = {
      ...frameItemToCatalogBoardItem(frame, overrides),
      ...(boardContainer ? { containerKind: boardContainer.kind, containerId: boardContainer.id } : {}),
    } satisfies CatalogBoardItem;
    boardSync.runtime?.upsertBoardItem(boardItem);
    addBoardItem(boardItem);
  }, [addBoardItem, boardContainer, boardSync.runtime]);

  const renameFrame = useCallback((frame: FrameBoardWorkspaceItem, title: string) => {
    upsertFrame(frame, { title });
  }, [upsertFrame]);

  const toggleFrameCollapsed = useCallback((frame: FrameBoardWorkspaceItem) => {
    upsertFrame(frame, { collapsed: !frame.collapsed });
  }, [upsertFrame]);

  const deleteFrame = useCallback((frame: FrameBoardWorkspaceItem) => {
    boardSync.runtime?.deleteBoardItem(frame.boardItemId);
    removeBoardItem(frame.boardItemId);
    clearBoardSelection();
  }, [boardSync.runtime, clearBoardSelection, removeBoardItem]);

  const moveBoardItemToContainer = useCallback(async (
    item: Extract<BoardWorkspaceItem, { type: "session" | "markdown" | "asset" | "custom_view" }>,
    target: BoardContainerRef,
  ) => {
    if (!onMoveBoardItemToContainer) return;
    const result = await onMoveBoardItemToContainer({
      boardItemId: item.boardItemId,
      container: target,
      x: item.x,
      y: item.y,
      idempotencyKey: createBoardMoveIdempotencyKey(item.boardItemId, target),
    });
    boardSync.runtime?.deleteBoardItem(item.boardItemId);
    addBoardItem(result.boardItem);
    clearBoardSelection();
  }, [addBoardItem, boardSync.runtime, clearBoardSelection, onMoveBoardItemToContainer]);

  useEffect(() => {
    if (!boardSync.connectionError) return;
    toastManager.add({
      title: "Board sync unavailable",
      description: boardSync.connectionError,
      type: "warning",
    });
  }, [boardSync.connectionError]);

  useEffect(() => {
    const previous = previousBoardSyncStatusRef.current;
    previousBoardSyncStatusRef.current = boardSync.connectionStatus;
    if (
      boardSync.connectionStatus === "connected" &&
      (previous === "disconnected" || previous === "reconnecting")
    ) {
      toastManager.add({
        title: "Board sync reconnected",
        description: "Board changes are live again.",
        type: "success",
      });
    }
  }, [boardSync.connectionStatus]);

  const openNewSessionAt = useCallback((position?: { x: number; y: number }) => {
    if (!boardContainer || !resolvedBoardFolderId) return;
    const resolved = position ?? resolveSpawnPosition();
    const boardPosition = snapBoardPosition(resolved.x, resolved.y);
    openNewSessionModal(
      "folder",
      null,
      {
        folderId: resolvedBoardFolderId,
        ...(boardContainer.kind === "runbook" ? { container: boardContainer } : {}),
        ...(boardPosition ? { boardPosition } : {}),
      },
    );
    setContextMenu(null);
    setNewMenuOpen(false);
  }, [boardContainer, openNewSessionModal, resolveSpawnPosition, resolvedBoardFolderId]);

  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) runGuardedLoadMore(loadMoreGateRef, onLoadMore);
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore]);

  const handleCanvasContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isBoardTileTarget(event.target)) return;
    const point = resolveBoardPoint(event.clientX, event.clientY);
    const position = snapBoardPosition(point.x, point.y);
    event.preventDefault();
    setCardContextMenu(null);
    setContextMenu({
      screenX: event.clientX,
      screenY: event.clientY,
      boardX: position.x,
      boardY: position.y,
    });
  };

  const itemPosition = (item: BoardWorkspaceItem) => {
    const preview = dragPreviewByItemId.get(item.boardItemId);
    return {
      ...boardToCanvasStyle(preview ?? { x: item.x, y: item.y }),
      zIndex: getBoardItemZIndex(item.boardItemId),
    };
  };

  const handleTileContextMenu = (event: ReactMouseEvent<HTMLElement>, item: BoardWorkspaceItem) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    selectSingleBoardItem(item.boardItemId);
    raiseBoardItems([item.boardItemId]);
    if (item.type === "session") {
      setCardContextMenu({ screenX: event.clientX, screenY: event.clientY, item });
      return;
    }
    if (item.type === "folder") {
      setCardContextMenu({ screenX: event.clientX, screenY: event.clientY, item });
      return;
    }
    setCardContextMenu({ screenX: event.clientX, screenY: event.clientY, item });
  };

  const closeCardContextMenu = () => setCardContextMenu(null);
  const openSession = useCallback((session: SessionSummary, item?: BoardWorkspaceItem) => {
    if (item) {
      selectSingleBoardItem(item.boardItemId);
      raiseBoardItems([item.boardItemId]);
    }
    toggleSessionSelection(session.agentSessionId, false, false, displaySessions);
    setActiveSessionSummary(session);
    if (isMobile) setActiveTab("chat");
  }, [
    displaySessions,
    isMobile,
    raiseBoardItems,
    selectSingleBoardItem,
    setActiveSessionSummary,
    setActiveTab,
    toggleSessionSelection,
  ]);
  const openChildRef = useCallback((child: DirectChildPortalItem) => {
    childStack.openChildRef(child);
    openSession(child.session);
  }, [childStack, openSession]);

  const updateAssetPlaceholder = useCallback((
    boardItemId: string,
    fields: Partial<AssetBoardWorkspaceItem>,
  ) => {
    setAssetPlaceholders((items) => items.map((item) =>
      item.boardItemId === boardItemId ? { ...item, ...fields } : item
    ));
  }, []);

  const handleDroppedFiles = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const files = fileListFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setCardContextMenu(null);
    if (!resolvedBoardFolderId || !boardContainer || !onUploadBoardAsset) {
      toastManager.add({
        title: "Board asset upload unavailable",
        description: "Asset upload is not configured for this board.",
        type: "warning",
      });
      return;
    }

    const preferredPoint = resolveBoardPoint(event.clientX, event.clientY);
    const placements = findEmptyPlacement({
      existingItems: boardItems,
      preferredPoint,
      size: { width: BOARD_TILE_WIDTH, height: BOARD_ASSET_TILE_HEIGHT },
      count: files.length,
    });

    files.forEach((file, index) => {
      const position = placements[index] ?? snapBoardPosition(preferredPoint.x, preferredPoint.y);
      const boardItemId = createUploadPlaceholderId();
      const sourceUrl = createObjectUrl(file);
      if (sourceUrl) assetObjectUrlsRef.current.add(sourceUrl);
      const placeholder: AssetBoardWorkspaceItem = {
        type: "asset",
        id: boardItemId,
        boardItemId,
        assetId: boardItemId,
        fileName: file.name || "Untitled file",
        mimeType: file.type || "application/octet-stream",
        byteSize: file.size,
        sourceUrl,
        uploadProgress: 0,
        uploadState: "uploading",
        x: position.x,
        y: position.y,
        width: BOARD_TILE_WIDTH,
        height: BOARD_ASSET_TILE_HEIGHT,
      };
      setAssetPlaceholders((items) => [...items, placeholder]);

      void (async () => {
        try {
          const metadata = await extractMediaMetadata(file, sourceUrl);
          const result = await onUploadBoardAsset({
            folderId: resolvedBoardFolderId,
            container: boardContainer,
            file,
            x: position.x,
            y: position.y,
            ...metadata,
            onProgress: (progress) => updateAssetPlaceholder(boardItemId, { uploadProgress: progress }),
          });
          rememberAssetSignedUrls([result.boardItem]);
          boardSync.runtime?.upsertBoardItem(result.boardItem);
          addBoardItem(result.boardItem);
          setAssetPlaceholders((items) => items.filter((item) => item.boardItemId !== boardItemId));
          revokeObjectUrl(sourceUrl);
          if (sourceUrl) assetObjectUrlsRef.current.delete(sourceUrl);
          selectSingleBoardItem(result.boardItem.id);
          raiseBoardItems([result.boardItem.id]);
        } catch (err) {
          updateAssetPlaceholder(boardItemId, {
            uploadState: "error",
            errorMessage: errorMessage(err),
          });
        }
      })();
    });
  }, [
    addBoardItem,
    boardContainer?.kind,
    boardItems,
    boardSync.runtime,
    onUploadBoardAsset,
    raiseBoardItems,
    rememberAssetSignedUrls,
    resolveBoardPoint,
    selectSingleBoardItem,
    boardContainer,
    resolvedBoardFolderId,
    updateAssetPlaceholder,
  ]);

  useEffect(() => () => {
    for (const url of assetObjectUrlsRef.current) revokeObjectUrl(url);
    assetObjectUrlsRef.current.clear();
  }, []);

  const canCreateBoardItems = Boolean(boardContainer);
  const runbookTitle = runbookSnapshot?.runbook.title ?? null;
  const runbookStatus = runbookSnapshot?.runbook.status ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BoardWorkspaceHeader
        breadcrumbs={breadcrumbs}
        selectedFolder={selectedFolder}
        selectedFolderId={selectedFolderId}
        boardContainer={boardContainer}
        runbookTitle={runbookTitle}
        runbookStatus={runbookStatus}
        runbookProgress={runbookBoardProgress}
        workspaceViewMode={workspaceViewMode}
        connectionStatus={boardSync.connectionStatus}
        connectionError={boardSync.connectionError}
        onWorkspaceViewModeChange={onWorkspaceViewModeChange}
        newMenuOpen={newMenuOpen}
        onToggleNewMenu={() => setNewMenuOpen((open) => !open)}
        onSelectFolder={selectFolder}
        canCreateBoardItems={canCreateBoardItems}
        onCreateFolder={() => openCreateFolderDialog()}
        onOpenNewSession={() => openNewSessionAt()}
        onCreateMarkdown={() => createMarkdownAt()}
        declutterDisabled={boardItems.length <= 1}
        onDeclutterBoard={handleDeclutterBoard}
        undoDeclutterDisabled={declutterUndoUpdates.length === 0}
        onUndoDeclutter={handleUndoDeclutter}
      />

      <div className="relative min-h-0 flex-1 px-3 pb-3">
        <div
          ref={scrollRef}
          data-testid="board-workspace-scroll"
          className={cn(
            "relative h-full min-h-0 overflow-auto rounded-[18px] border border-white/8 bg-[var(--lg-card)] shadow-[0_8px_26px_-18px_rgb(20_26_40_/_45%)]",
            isSpaceDown && "cursor-grab",
            isPanning && "cursor-grabbing",
          )}
          onPointerDown={handleCanvasPointerDown}
          onDragOver={(event) => {
            if (!hasDraggedFiles(event.dataTransfer)) return;
            event.preventDefault();
          }}
          onDrop={handleDroppedFiles}
          onContextMenu={handleCanvasContextMenu}
          onClick={() => {
            setContextMenu(null);
            setCardContextMenu(null);
            childStack.closeChildStack();
          }}
        >
          <div data-testid="board-workspace-plane" style={planeStyle}>
            <div
              data-testid="board-workspace-canvas"
              className="relative"
              style={canvasStyle}
            >
              <BoardWorkspaceCanvasContent
                isLoading={boardSync.isLoading}
                boardItems={boardItems}
                activeSessionKey={activeSessionKey}
                selectedBoardItemIds={selectedBoardItemIds}
                pulseBoardItemId={childStack.pulseBoardItemId}
                expandedStackParentId={childStack.expandedStackParentId}
                remoteSelectionByItemId={remoteSelectionByItemId}
                dragPreviews={dragPreviews}
                marqueeRect={marqueeRect}
                hasMore={hasMore}
                onLoadMore={onLoadMore}
                sentinelRef={sentinelRef}
                expandedParentItem={childStack.expandedParentItem}
                expandedChildren={childStack.expandedChildren}
                itemPosition={itemPosition}
                boardToCanvasStyle={boardToCanvasStyle}
                onTilePointerDown={handleTilePointerDown}
                onTileContextMenu={handleTileContextMenu}
                shouldSuppressTileClick={shouldSuppressTileClick}
                onToggleChildStack={childStack.toggleChildStack}
                onNavigateToParent={childStack.navigateToParent}
                onOpenChildRef={openChildRef}
                onToggleFrameCollapsed={toggleFrameCollapsed}
                onOpenSession={openSession}
                onOpenFolder={(item, folderId) => {
                  selectSingleBoardItem(item.boardItemId);
                  raiseBoardItems([item.boardItemId]);
                  selectFolder(folderId);
                }}
                onOpenRunbookBoard={(runbookId) => {
                  openRunbookBoard(runbookId, selectedFolderId);
                }}
                onOpenMarkdown={(item, documentId) => {
                  selectSingleBoardItem(item.boardItemId);
                  raiseBoardItems([item.boardItemId]);
                  setActiveBoardDocument(documentId);
                  if (isMobile) setActiveTab("chat");
                }}
                onOpenCustomView={(item, customViewId) => {
                  selectSingleBoardItem(item.boardItemId);
                  raiseBoardItems([item.boardItemId]);
                  setActiveCustomView(customViewId);
                  if (isMobile) setActiveTab("chat");
                }}
                fixedRunbookCard={
                  isRunbookBoard && runbookId
                    ? { runbookId, fallbackTitle: runbookTitle ?? "런북 보드" }
                    : null
                }
                emptyMessage={
                  isRunbookBoard
                    ? "아직 이 런북 보드에 배치된 항목이 없음"
                    : undefined
                }
              />
            </div>
          </div>

          <BoardWorkspaceContextMenus
            contextMenu={contextMenu}
            cardContextMenu={cardContextMenu}
            displaySessions={displaySessions}
            folders={folders}
            boardContainer={boardContainer}
            resolvedBoardFolderId={resolvedBoardFolderId}
            runbookMoveTargets={runbookMoveTargets}
            activeBoardDocumentId={activeBoardDocumentId}
            boardYjsRuntime={boardSync.runtime}
            canCreateBoardItems={canCreateBoardItems}
            canCreateStructureItems={boardContainer?.kind === "folder"}
            onCloseCardContextMenu={closeCardContextMenu}
            onOpenCreateFolder={openCreateFolderDialog}
            onOpenNewSession={openNewSessionAt}
            onCreateMarkdown={createMarkdownAt}
            onCreateFrame={createFrameAt}
            onRenameFrame={renameFrame}
            onToggleFrameCollapsed={toggleFrameCollapsed}
            onDeleteFrame={deleteFrame}
            onMoveBoardItemToContainer={moveBoardItemToContainer}
            onMoveSessions={onMoveSessions}
            onRenameSession={onRenameSession}
            onDeleteSessions={onDeleteSessions}
            onContinueSession={onContinueSession}
            getContinueSessionDisabledReason={getContinueSessionDisabledReason}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
            onUpdateFolderSettings={onUpdateFolderSettings}
          />
        </div>
        <BoardWorkspaceZoomControls
          zoom={zoom}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
        />
        <BoardWorkspaceMinimap
          boardItems={boardItems}
          zoom={zoom}
          viewport={viewport}
          collapsed={minimapCollapsed}
          onCollapsedChange={setMinimapCollapsed}
          onMoveViewport={handleMinimapMoveViewport}
        />
      </div>

      <FolderDialog
        mode="create"
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onConfirm={handleCreateFolder}
      />
    </div>
  );
}
