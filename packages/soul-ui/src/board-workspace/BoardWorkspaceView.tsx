import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import type { CatalogBoardItem, SessionSummary } from "../shared/types";
import { FolderDialog } from "../components/FolderDialog";
import { runGuardedLoadMore } from "../components/load-more-guard";
import { toastManager } from "../components/ui/toast";
import { useIsMobile } from "../hooks/use-mobile";
import { cn } from "../lib/cn";
import { applyCatalogDisplayNames } from "../hooks/session-stream-helpers";
import { BoardWorkspaceCanvasContent } from "./BoardWorkspaceCanvasContent";
import {
  boardToCanvasStyle,
  buildBoardWorkspaceItems,
  snapBoardPosition,
  type BoardWorkspaceItem,
} from "./board-workspace-items";
import { isBoardTileTarget } from "./board-workspace-dom";
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
import {
  buildBoardSessionRelations,
  getSameFolderChildBoardItemIdsToRemove,
  type DirectChildPortalItem,
} from "./board-session-relations";
import { findOpenBoardPositionInViewport, getFallbackBoardSpawnViewport } from "./board-spawn";
import { useBoardChildStackState } from "./useBoardChildStackState";
import type { BoardWorkspaceViewProps } from "./BoardWorkspaceView.types";
export type { BoardWorkspaceViewProps, CreateMarkdownDocumentInput, CreateMarkdownDocumentResult } from "./BoardWorkspaceView.types";
const EMPTY_SESSIONS: SessionSummary[] = [];
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
  const setActiveSessionSummary = useDashboardStore((s) => s.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);
  const setActiveBoardDocument = useDashboardStore((s) => s.setActiveBoardDocument);
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);
  const toggleSessionSelection = useDashboardStore((s) => s.toggleSessionSelection);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const activeBoardDocumentId = useDashboardStore((s) => s.activeBoardDocumentId);
  const addBoardItem = useDashboardStore((s) => s.addBoardItem);
  const setBoardItemsForFolder = useDashboardStore((s) => s.setBoardItemsForFolder);
  const updateBoardItemPosition = useDashboardStore((s) => s.updateBoardItemPosition);
  const removeBoardItem = useDashboardStore((s) => s.removeBoardItem);
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

  useEffect(() => {
    if (!selectedFolderId) return;
    const controller = new AbortController();
    fetch(`/api/board-items?folder_id=${encodeURIComponent(selectedFolderId)}`, {
      signal: controller.signal,
    })
      .then((r) => {
        if (r.ok) return r.json();
        throw new Error("board items fetch failed");
      })
      .then((data) => {
        if (Array.isArray(data?.boardItems)) {
          setBoardItemsForFolder(selectedFolderId, data.boardItems);
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });
    return () => {
      controller.abort();
    };
  }, [selectedFolderId, setBoardItemsForFolder]);

  const effectiveCatalog = useMemo(() => {
    if (!catalog || !boardSync.boardItems || boardSync.isLoading) return catalog;
    return { ...catalog, boardItems: boardSync.boardItems };
  }, [boardSync.boardItems, boardSync.isLoading, catalog]);
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
      ...(relationIndex ? { relationIndex } : {}),
    });
  }, [effectiveCatalog, selectedFolderId, displaySessions, relationIndex]);
  const childStack = useBoardChildStackState({
    boardItems,
    relationIndex,
    selectedFolderId,
    selectFolder,
  });
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

  const resolveSpawnPosition = useCallback(() => {
    const spawnViewport = viewport.width > 0 && viewport.height > 0
      ? viewport
      : getFallbackBoardSpawnViewport(zoom);
    return findOpenBoardPositionInViewport(boardItems, {
      viewport: spawnViewport,
      zoom,
    });
  }, [boardItems, viewport, zoom]);

  useEffect(() => {
    if (!effectiveCatalog || !relationIndex || !boardSync.runtime) return;
    const ids = getSameFolderChildBoardItemIdsToRemove(effectiveCatalog, relationIndex, selectedFolderId);
    if (ids.length === 0) return;
    for (const id of ids) {
      boardSync.runtime.deleteBoardItem(id);
      removeBoardItem(id);
    }
  }, [boardSync.runtime, effectiveCatalog, relationIndex, removeBoardItem, selectedFolderId]);

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
    const resolved = position ?? resolveSpawnPosition();
    setCreateFolderPosition(snapBoardPosition(resolved.x, resolved.y));
    setCreateDialogOpen(true);
    setContextMenu(null);
    setNewMenuOpen(false);
  };

  const createMarkdownAt = useCallback(async (position?: { x: number; y: number }) => {
    if (!selectedFolderId || !boardSync.runtime) return;
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
  }, [addBoardItem, boardSync.runtime, isMobile, resolveSpawnPosition, selectedFolderId, setActiveBoardDocument, setActiveTab]);

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
    const resolved = position ?? resolveSpawnPosition();
    const boardPosition = snapBoardPosition(resolved.x, resolved.y);
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
  }, [openNewSessionModal, resolveSpawnPosition, selectedFolderId]);

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
                onOpenSession={openSession}
                onOpenFolder={(item, folderId) => {
                  selectSingleBoardItem(item.boardItemId);
                  raiseBoardItems([item.boardItemId]);
                  selectFolder(folderId);
                }}
                onOpenMarkdown={(item, documentId) => {
                  selectSingleBoardItem(item.boardItemId);
                  raiseBoardItems([item.boardItemId]);
                  setActiveBoardDocument(documentId);
                  if (isMobile) setActiveTab("chat");
                }}
              />
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
