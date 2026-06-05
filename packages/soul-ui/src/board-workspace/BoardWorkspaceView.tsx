import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
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
  BOARD_TILE_WIDTH,
  BOARD_TILE_HEIGHT,
  BOARD_CANVAS_WIDTH,
  BOARD_CANVAS_HEIGHT,
  BOARD_CANVAS_ORIGIN_X,
  BOARD_CANVAS_ORIGIN_Y,
  BOARD_GRID_SIZE,
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
import { useBoardWorkspaceDrag } from "./useBoardWorkspaceDrag";
import { useBoardYjsRuntime } from "./board-yjs-client";

const EMPTY_SESSIONS: SessionSummary[] = [];
const DOT_GRID_STYLE = {
  backgroundImage: "radial-gradient(circle, hsl(var(--muted-foreground) / 0.34) 1px, transparent 1px)",
  backgroundSize: `${BOARD_GRID_SIZE}px ${BOARD_GRID_SIZE}px`,
  backgroundPosition: `${BOARD_CANVAS_ORIGIN_X % BOARD_GRID_SIZE}px ${BOARD_CANVAS_ORIGIN_Y % BOARD_GRID_SIZE}px`,
} satisfies CSSProperties;

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
  const removeBoardItem = useDashboardStore((s) => s.removeBoardItem);
  const updateBoardItemPosition = useDashboardStore((s) => s.updateBoardItemPosition);
  const isMobile = useIsMobile();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createFolderPosition, setCreateFolderPosition] = useState<{ x: number; y: number } | null>(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<BoardContextMenuState | null>(null);
  const [cardContextMenu, setCardContextMenu] = useState<BoardCardContextMenuState | null>(null);
  const [selectedBoardItemId, setSelectedBoardItemId] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreGateRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const folders = catalog?.folders ?? [];
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const displaySessions = useMemo(() => applyCatalogDisplayNames(sessions, catalog), [sessions, catalog]);
  const boardSync = useBoardYjsRuntime({
    folderId: selectedFolderId,
    catalog,
    selectionItemId: selectedBoardItemId,
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
  const {
    dragPreview,
    handleCanvasPointerDown,
    handleTilePointerDown,
    isPanning,
    isSpaceDown,
    shouldSuppressTileClick,
  } = useBoardWorkspaceDrag({
    scrollRef,
    updateBoardItemPosition: yjsUpdateBoardItemPosition,
  });

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

  const resolveBoardPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = scrollRef.current?.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]');
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: clientX - rect.left - BOARD_CANVAS_ORIGIN_X,
      y: clientY - rect.top - BOARD_CANVAS_ORIGIN_Y,
    };
  }, []);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollLeft = BOARD_CANVAS_ORIGIN_X - 80;
    scroller.scrollTop = BOARD_CANVAS_ORIGIN_Y - 60;
  }, [selectedFolderId]);

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
    const position = snapBoardPosition(resolveBoardPoint(event.clientX, event.clientY).x, resolveBoardPoint(event.clientX, event.clientY).y);
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
    return boardToCanvasStyle({ x: item.x, y: item.y });
  };

  const handleTileContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, item: BoardWorkspaceItem) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setSelectedBoardItemId(item.boardItemId);
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
        onWorkspaceViewModeChange={onWorkspaceViewModeChange}
        newMenuOpen={newMenuOpen}
        onToggleNewMenu={() => setNewMenuOpen((open) => !open)}
        onSelectFolder={selectFolder}
        onCreateFolder={() => openCreateFolderDialog()}
        onOpenNewSession={() => openNewSessionAt()}
        onCreateMarkdown={() => createMarkdownAt()}
      />

      <div
        ref={scrollRef}
        data-testid="board-workspace-scroll"
        className={cn(
          "relative min-h-0 flex-1 overflow-auto",
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
        <div
          data-testid="board-workspace-canvas"
          className="relative bg-background"
          style={{
            width: BOARD_CANVAS_WIDTH,
            height: BOARD_CANVAS_HEIGHT,
            ...DOT_GRID_STYLE,
          }}
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

          {boardItems.map((item) => {
            return (
              <BoardWorkspaceTile
                key={item.id}
                item={item}
                style={itemPosition(item)}
                activeSessionKey={activeSessionKey}
                isSelected={
                  selectedBoardItemId === item.boardItemId ||
                  (item.type === "session" && activeSessionKey === item.session.agentSessionId) ||
                  (item.type === "markdown" && activeBoardDocumentId === item.documentId)
                }
                remoteSelectionColor={remoteSelectionByItemId.get(item.boardItemId)}
                onTilePointerDown={handleTilePointerDown}
                onTileContextMenu={handleTileContextMenu}
                shouldSuppressClick={shouldSuppressTileClick}
                onOpenFolder={(folderId) => {
                  setSelectedBoardItemId(item.boardItemId);
                  selectFolder(folderId);
                }}
                onOpenMarkdown={(documentId) => {
                  setSelectedBoardItemId(item.boardItemId);
                  setActiveBoardDocument(documentId);
                  if (isMobile) setActiveTab("chat");
                }}
                onOpenSession={(session) => {
                  setSelectedBoardItemId(item.boardItemId);
                  setActiveSession(session.agentSessionId);
                  setActiveSessionSummary(session);
                  if (isMobile) setActiveTab("chat");
                }}
              />
            );
          })}

          {dragPreview && (
            <div
              data-testid="board-drag-ghost"
              className="pointer-events-none absolute z-20 h-[160px] w-[280px] rounded-md border-2 border-dashed border-primary/70 bg-primary/10 opacity-50"
              style={boardToCanvasStyle(snapBoardPosition(dragPreview.x, dragPreview.y))}
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

      <FolderDialog
        mode="create"
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onConfirm={handleCreateFolder}
      />
    </div>
  );
}
