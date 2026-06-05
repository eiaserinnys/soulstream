import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Loader2 } from "lucide-react";

import { useDashboardStore } from "../stores/dashboard-store";
import type { CatalogBoardItem, CatalogFolder, FolderSettings, MarkdownDocument, SessionSummary } from "../shared/types";
import { FolderDialog } from "../components/FolderDialog";
import { runGuardedLoadMore, type LoadMoreCallback } from "../components/load-more-guard";
import { toastManager } from "../components/ui/toast";
import { useIsMobile } from "../hooks/use-mobile";
import { cn } from "../lib/cn";
import { applyCatalogDisplayNames } from "../hooks/session-stream-helpers";
import type { FolderWorkspaceViewMode } from "./folder-workspace-view-mode";
import { BoardWorkspaceTile } from "./BoardWorkspaceTile";
import {
  BOARD_CANVAS_WIDTH,
  BOARD_CANVAS_ORIGIN_X,
  BOARD_CANVAS_ORIGIN_Y,
  buildBoardWorkspaceItems,
  findFirstOpenBoardPosition,
  snapBoardPosition,
  type BoardWorkspaceItem,
} from "./board-workspace-items";

import { getFolderBreadcrumbs } from "./board-workspace-helpers";
import { BoardWorkspaceHeader } from "./BoardWorkspaceHeader";
import {
  BoardWorkspaceContextMenus,
  type BoardCardContextMenuState,
  type BoardContextMenuState,
} from "./BoardWorkspaceContextMenus";
import { useBoardYjsRuntime } from "./board-yjs-client";
import { BoardWorkspaceMinimap } from "./BoardWorkspaceMinimap";
import type { BoardItemPositionUpdate } from "./board-selection";
import { useBoardSelectionState } from "./useBoardSelectionState";
import { useBoardCanvasViewport } from "./useBoardCanvasViewport";

const EMPTY_SESSIONS: SessionSummary[] = [];

export interface CreateMarkdownDocumentInput {
  folderId: string;
  title: string;
  body: string;
  x: number;
  y: number;
}

export interface CreateMarkdownDocumentResult {
  document: MarkdownDocument;
  boardItem: CatalogBoardItem;
}

export interface BoardWorkspaceViewProps {
  sessions?: SessionSummary[];
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  onDeleteSessions?: (sessionIds: string[]) => Promise<void>;
  onCreateFolder?: (name: string, parentFolderId: string | null) => Promise<CatalogFolder | void> | CatalogFolder | void;
  onRenameFolder?: (folderId: string, name: string) => Promise<void> | void;
  onDeleteFolder?: (folderId: string) => Promise<void> | void;
  onUpdateFolderSettings?: (folderId: string, settings: FolderSettings) => Promise<void> | void;
  onUpdateBoardItemPosition?: (boardItemId: string, x: number, y: number) => Promise<void> | void;
  onCreateMarkdownDocument?: (input: CreateMarkdownDocumentInput) => Promise<CreateMarkdownDocumentResult>;
  onLoadMore?: LoadMoreCallback;
  hasMore?: boolean;
  workspaceViewMode?: FolderWorkspaceViewMode;
  onWorkspaceViewModeChange?: (mode: FolderWorkspaceViewMode) => void;
}

function isBoardTileTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("[data-board-tile='true']"));
}

export function BoardWorkspaceView({
  sessions = EMPTY_SESSIONS,
  onMoveSessions,
  onRenameSession,
  onDeleteSessions,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onUpdateFolderSettings,
  onUpdateBoardItemPosition: _onUpdateBoardItemPosition,
  onCreateMarkdownDocument: _onCreateMarkdownDocument,
  onLoadMore,
  hasMore,
  workspaceViewMode,
  onWorkspaceViewModeChange,
}: BoardWorkspaceViewProps) {
  const catalog = useDashboardStore((s) => s.catalog);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((s) => s.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);
  const setActiveBoardDocument = useDashboardStore((s) => s.setActiveBoardDocument);
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const activeBoardDocumentId = useDashboardStore((s) => s.activeBoardDocumentId);
  const addBoardItem = useDashboardStore((s) => s.addBoardItem);
  const updateBoardItemPosition = useDashboardStore((s) => s.updateBoardItemPosition);
  const isMobile = useIsMobile();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createFolderPosition, setCreateFolderPosition] = useState<{ x: number; y: number } | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<BoardContextMenuState | null>(null);
  const [cardContextMenu, setCardContextMenu] = useState<BoardCardContextMenuState | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
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
  const displaySessions = useMemo(() => applyCatalogDisplayNames(sessions, catalog), [sessions, catalog]);
  const boardSync = useBoardYjsRuntime({
    folderId: selectedFolderId,
    catalog,
    selectionItemId: primarySelectedBoardItemId,
  });
  const effectiveCatalog = useMemo(() => {
    if (!catalog || !boardSync.boardItems || boardSync.isLoading) return catalog;
    return { ...catalog, boardItems: boardSync.boardItems };
  }, [boardSync.boardItems, boardSync.isLoading, catalog]);
  const remoteSelectionByItemId = useMemo(() => {
    const selections = new Map<string, string>();
    for (const selection of boardSync.remoteSelections) {
      selections.set(selection.itemId, selection.color);
    }
    return selections;
  }, [boardSync.remoteSelections]);
  const yjsUpdateBoardItemPosition = useCallback((boardItemId: string, x: number, y: number) => {
    boardSync.runtime?.updateBoardItemPosition(boardItemId, x, y);
    updateBoardItemPosition(boardItemId, x, y);
  }, [boardSync.runtime, updateBoardItemPosition]);

  const breadcrumbs = useMemo(
    () => getFolderBreadcrumbs(folders, selectedFolderId),
    [folders, selectedFolderId],
  );

  const boardItems = useMemo(() => {
    if (!effectiveCatalog) return [];
    return buildBoardWorkspaceItems({
      catalog: effectiveCatalog,
      selectedFolderId,
      sessions: displaySessions,
    });
  }, [effectiveCatalog, selectedFolderId, displaySessions]);

  const yjsUpdateBoardItemPositions = useCallback((updates: BoardItemPositionUpdate[]) => {
    for (const update of updates) {
      yjsUpdateBoardItemPosition(update.boardItemId, update.x, update.y);
    }
  }, [yjsUpdateBoardItemPosition]);

  const {
    scrollRef,
    zoom,
    viewport,
    minimapCollapsed,
    setMinimapCollapsed,
    resolveBoardPoint,
    handleMinimapMoveViewport,
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
    selectedFolderId,
    boardItems,
    selectedBoardItemIds,
    selectBoardItems,
    toggleBoardItemSelection,
    clearBoardSelection,
    raiseBoardItems,
    updateBoardItemPositions: yjsUpdateBoardItemPositions,
  });

  const handleCreateFolder = async (name: string) => {
    const position = createFolderPosition ? snapBoardPosition(createFolderPosition.x, createFolderPosition.y) : null;
    const created = await onCreateFolder?.(name.trim(), selectedFolderId);
    if (created && position && selectedFolderId) {
      const boardItem: CatalogBoardItem = {
        id: `subfolder:${created.id}`,
        folderId: selectedFolderId,
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
    setCreateFolderPosition(position ? snapBoardPosition(position.x, position.y) : null);
    setCreateDialogOpen(true);
    setContextMenu(null);
    setNewMenuOpen(false);
  };

  const createMarkdownAt = useCallback(async (position?: { x: number; y: number }) => {
    if (!selectedFolderId || !boardSync.runtime) return;
    const resolved = position ?? findFirstOpenBoardPosition(boardItems);
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
  }, [addBoardItem, boardItems, boardSync.runtime, isMobile, selectedFolderId, setActiveBoardDocument, setActiveTab]);

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
    const boardPosition = position ? snapBoardPosition(position.x, position.y) : undefined;
    openNewSessionModal(
      "folder",
      null,
      {
        ...(selectedFolderId ? { folderId: selectedFolderId } : {}),
        ...(boardPosition ? { boardPosition } : {}),
      },
    );
    setContextMenu(null);
    setNewMenuOpen(false);
  }, [openNewSessionModal, selectedFolderId]);

  const boardToCanvasStyle = useCallback((position: { x: number; y: number }) => ({
    left: BOARD_CANVAS_ORIGIN_X + position.x,
    top: BOARD_CANVAS_ORIGIN_Y + position.y,
  }), []);

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

  const handleTileContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, item: BoardWorkspaceItem) => {
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BoardWorkspaceHeader
        breadcrumbs={breadcrumbs}
        selectedFolder={selectedFolder}
        selectedFolderId={selectedFolderId}
        workspaceViewMode={workspaceViewMode}
        connectionStatus={boardSync.connectionStatus}
        connectionError={boardSync.connectionError}
        onWorkspaceViewModeChange={onWorkspaceViewModeChange}
        newMenuOpen={newMenuOpen}
        onToggleNewMenu={() => setNewMenuOpen((open) => !open)}
        onSelectFolder={selectFolder}
        onCreateFolder={() => openCreateFolderDialog()}
        onOpenNewSession={() => openNewSessionAt()}
        onCreateMarkdown={() => createMarkdownAt()}
      />

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-testid="board-workspace-scroll"
          className={cn(
            "h-full min-h-0 overflow-auto",
            isSpaceDown && "cursor-grab",
            isPanning && "cursor-grabbing",
          )}
          onPointerDown={handleCanvasPointerDown}
          onContextMenu={handleCanvasContextMenu}
          onClick={() => {
            setContextMenu(null);
            setCardContextMenu(null);
          }}
        >
          <div data-testid="board-workspace-plane" style={planeStyle}>
            <div
              data-testid="board-workspace-canvas"
              className="relative"
              style={canvasStyle}
            >
              {boardSync.isLoading && (
                <div className="absolute left-3 top-3 z-30 rounded-md border border-border bg-background/90 p-2 shadow-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
                  <span className="sr-only">Loading board sync</span>
                </div>
              )}

              {boardItems.length === 0 && !boardSync.isLoading && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  No folders or sessions on this board
                </div>
              )}

              {boardItems.map((item) => (
                <BoardWorkspaceTile
                  key={item.id}
                  item={item}
                  style={itemPosition(item)}
                  activeSessionKey={activeSessionKey}
                  isSelected={selectedBoardItemIds.has(item.boardItemId)}
                  remoteSelectionColor={remoteSelectionByItemId.get(item.boardItemId)}
                  onTilePointerDown={handleTilePointerDown}
                  onTileContextMenu={handleTileContextMenu}
                  shouldSuppressClick={shouldSuppressTileClick}
                  onOpenFolder={(folderId) => {
                    selectSingleBoardItem(item.boardItemId);
                    raiseBoardItems([item.boardItemId]);
                    selectFolder(folderId);
                  }}
                  onOpenMarkdown={(documentId) => {
                    selectSingleBoardItem(item.boardItemId);
                    raiseBoardItems([item.boardItemId]);
                    setActiveBoardDocument(documentId);
                    if (isMobile) setActiveTab("chat");
                  }}
                  onOpenSession={(session) => {
                    selectSingleBoardItem(item.boardItemId);
                    raiseBoardItems([item.boardItemId]);
                    setActiveSession(session.agentSessionId);
                    setActiveSessionSummary(session);
                    if (isMobile) setActiveTab("chat");
                  }}
                />
              ))}

              {dragPreviews[0] && (
                <div
                  data-testid="board-drag-ghost"
                  className="pointer-events-none absolute z-20 h-[160px] w-[280px] rounded-md border-2 border-dashed border-primary/70 bg-primary/10 opacity-50"
                  style={boardToCanvasStyle(snapBoardPosition(dragPreviews[0].x, dragPreviews[0].y))}
                />
              )}

              {marqueeRect && (
                <div
                  data-testid="board-marquee"
                  className="pointer-events-none absolute z-30 rounded-sm border border-primary bg-primary/10"
                  style={{
                    left: BOARD_CANVAS_ORIGIN_X + marqueeRect.x,
                    top: BOARD_CANVAS_ORIGIN_Y + marqueeRect.y,
                    width: marqueeRect.width,
                    height: marqueeRect.height,
                  }}
                />
              )}

              {hasMore && onLoadMore && (
                <div
                  ref={sentinelRef}
                  data-testid="board-load-more-sentinel"
                  className="absolute bottom-0 left-0 flex items-center justify-center py-3 text-xs text-muted-foreground"
                  style={{ width: BOARD_CANVAS_WIDTH }}
                >
                  <Loader2
                    data-testid="board-load-more-spinner"
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  <span className="sr-only">Loading more board items</span>
                </div>
              )}
            </div>
          </div>

          <BoardWorkspaceContextMenus
            contextMenu={contextMenu}
            cardContextMenu={cardContextMenu}
            displaySessions={displaySessions}
            folders={folders}
            activeBoardDocumentId={activeBoardDocumentId}
            boardYjsRuntime={boardSync.runtime}
            onCloseCardContextMenu={closeCardContextMenu}
            onOpenCreateFolder={openCreateFolderDialog}
            onOpenNewSession={openNewSessionAt}
            onCreateMarkdown={createMarkdownAt}
            onMoveSessions={onMoveSessions}
            onRenameSession={onRenameSession}
            onDeleteSessions={onDeleteSessions}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
            onUpdateFolderSettings={onUpdateFolderSettings}
          />
        </div>
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
