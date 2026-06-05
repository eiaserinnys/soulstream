import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronRight,
  FolderPlus,
  List,
  Loader2,
  Plus,
  SquarePen,
} from "lucide-react";

import { useDashboardStore } from "../stores/dashboard-store";
import type { CatalogBoardItem, MarkdownDocument, SessionSummary } from "../shared/types";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { FolderDialog } from "../components/FolderDialog";
import { runGuardedLoadMore, type LoadMoreCallback } from "../components/load-more-guard";
import { useIsMobile } from "../hooks/use-mobile";
import { cn } from "../lib/cn";
import { applyCatalogDisplayNames } from "../hooks/session-stream-helpers";
import type { FolderWorkspaceViewMode } from "./folder-workspace-view-mode";
import { BoardWorkspaceTile } from "./BoardWorkspaceTile";
import {
  BOARD_TILE_SIZE,
  buildBoardWorkspaceItems,
  computeBoardCanvasSize,
  findFirstOpenBoardPosition,
  snapBoardPosition,
  type BoardWorkspaceItem,
} from "./board-workspace-items";

import { getFolderBreadcrumbs } from "./board-workspace-helpers";

const EMPTY_SESSIONS: SessionSummary[] = [];
const DOT_GRID_STYLE = {
  backgroundImage: "radial-gradient(circle, hsl(var(--muted-foreground) / 0.28) 1px, transparent 1px)",
  backgroundSize: "40px 40px",
} satisfies CSSProperties;

interface BoardContextMenuState {
  screenX: number;
  screenY: number;
  boardX: number;
  boardY: number;
}

interface DragState {
  item: BoardWorkspaceItem;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
}

interface PanState {
  startClientX: number;
  startClientY: number;
  scrollLeft: number;
  scrollTop: number;
}

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
  onCreateFolder?: (name: string, parentFolderId: string | null) => Promise<void> | void;
  onUpdateBoardItemPosition?: (boardItemId: string, x: number, y: number) => Promise<void> | void;
  onCreateMarkdownDocument?: (input: CreateMarkdownDocumentInput) => Promise<CreateMarkdownDocumentResult>;
  onLoadMore?: LoadMoreCallback;
  hasMore?: boolean;
  workspaceViewMode?: FolderWorkspaceViewMode;
  onWorkspaceViewModeChange?: (mode: FolderWorkspaceViewMode) => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function isBoardTileTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("[data-board-tile='true']"));
}

export function BoardWorkspaceView({
  sessions = EMPTY_SESSIONS,
  onCreateFolder,
  onUpdateBoardItemPosition,
  onCreateMarkdownDocument,
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
  const addBoardItem = useDashboardStore((s) => s.addBoardItem);
  const updateBoardItemPosition = useDashboardStore((s) => s.updateBoardItemPosition);
  const isMobile = useIsMobile();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<BoardContextMenuState | null>(null);
  const [isSpaceDown, setIsSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [dragPreview, setDragPreview] = useState<{ boardItemId: string; x: number; y: number } | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreGateRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const dragPreviewRef = useRef<{ boardItemId: string; x: number; y: number } | null>(null);
  const panStateRef = useRef<PanState | null>(null);
  const suppressClickRef = useRef(false);

  const folders = catalog?.folders ?? [];
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const displaySessions = useMemo(() => applyCatalogDisplayNames(sessions, catalog), [sessions, catalog]);

  const breadcrumbs = useMemo(
    () => getFolderBreadcrumbs(folders, selectedFolderId),
    [folders, selectedFolderId],
  );

  const boardItems = useMemo(() => {
    if (!catalog) return [];
    return buildBoardWorkspaceItems({
      catalog,
      selectedFolderId,
      sessions: displaySessions,
    });
  }, [catalog, selectedFolderId, displaySessions]);

  const canvasSize = useMemo(() => computeBoardCanvasSize(boardItems), [boardItems]);

  const handleCreateFolder = async (name: string) => {
    await onCreateFolder?.(name.trim(), selectedFolderId);
    setCreateDialogOpen(false);
  };

  const createMarkdownAt = useCallback(async (position?: { x: number; y: number }) => {
    if (!selectedFolderId || !onCreateMarkdownDocument) return;
    const resolved = position ?? findFirstOpenBoardPosition(boardItems);
    const snapped = snapBoardPosition(resolved.x, resolved.y);
    try {
      const result = await onCreateMarkdownDocument({
        folderId: selectedFolderId,
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
  }, [addBoardItem, boardItems, isMobile, onCreateMarkdownDocument, selectedFolderId, setActiveBoardDocument, setActiveTab]);

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isEditableTarget(event.target)) return;
      event.preventDefault();
      setIsSpaceDown(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      setIsSpaceDown(false);
      setIsPanning(false);
      panStateRef.current = null;
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (drag) {
        const next = {
          boardItemId: drag.item.boardItemId,
          x: Math.max(0, drag.originX + event.clientX - drag.startClientX),
          y: Math.max(0, drag.originY + event.clientY - drag.startClientY),
        };
        if (Math.abs(next.x - drag.originX) >= 2 || Math.abs(next.y - drag.originY) >= 2) {
          suppressClickRef.current = true;
        }
        dragPreviewRef.current = next;
        setDragPreview(next);
        return;
      }
      const pan = panStateRef.current;
      const scroller = scrollRef.current;
      if (pan && scroller) {
        scroller.scrollLeft = pan.scrollLeft - (event.clientX - pan.startClientX);
        scroller.scrollTop = pan.scrollTop - (event.clientY - pan.startClientY);
      }
    };

    const handlePointerUp = async () => {
      const drag = dragStateRef.current;
      if (drag) {
        const preview = dragPreviewRef.current;
        const snapped = snapBoardPosition(preview?.x ?? drag.originX, preview?.y ?? drag.originY);
        dragStateRef.current = null;
        dragPreviewRef.current = null;
        setDragPreview(null);
        updateBoardItemPosition(drag.item.boardItemId, snapped.x, snapped.y);
        try {
          await onUpdateBoardItemPosition?.(drag.item.boardItemId, snapped.x, snapped.y);
        } catch (err) {
          updateBoardItemPosition(drag.item.boardItemId, drag.originX, drag.originY);
          console.error("Board item position update failed:", err);
        }
      }
      panStateRef.current = null;
      setIsPanning(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [onUpdateBoardItemPosition, updateBoardItemPosition]);

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isSpaceDown || event.button !== 0 || isBoardTileTarget(event.target)) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    event.preventDefault();
    panStateRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
    };
    setIsPanning(true);
  };

  const handleCanvasContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isBoardTileTarget(event.target)) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const position = snapBoardPosition(
      event.clientX - rect.left + scroller.scrollLeft,
      event.clientY - rect.top + scroller.scrollTop,
    );
    event.preventDefault();
    setContextMenu({
      screenX: event.clientX,
      screenY: event.clientY,
      boardX: position.x,
      boardY: position.y,
    });
  };

  const handleTilePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, item: BoardWorkspaceItem) => {
    if (event.button !== 0 || isSpaceDown) return;
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      item,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: item.x,
      originY: item.y,
    };
    dragPreviewRef.current = { boardItemId: item.boardItemId, x: item.x, y: item.y };
    suppressClickRef.current = false;
    setDragPreview(dragPreviewRef.current);
  };

  const shouldSuppressTileClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  const itemPosition = (item: BoardWorkspaceItem) => {
    if (dragPreview?.boardItemId === item.boardItemId) {
      return { left: dragPreview.x, top: dragPreview.y };
    }
    return { left: item.x, top: item.y };
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1">
          {breadcrumbs.map((folder, index) => (
            <div key={folder.id} className="flex min-w-0 items-center gap-1">
              {index > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              <button
                type="button"
                className={`truncate text-sm font-medium hover:text-foreground ${
                  folder.id === selectedFolderId ? "text-foreground" : "text-muted-foreground"
                }`}
                aria-current={folder.id === selectedFolderId ? "page" : undefined}
                onClick={() => selectFolder(folder.id)}
              >
                {folder.name}
              </button>
            </div>
          ))}
          {breadcrumbs.length === 0 && (
            <span className="truncate text-sm font-semibold">
              {selectedFolder?.name ?? "Folder"}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {workspaceViewMode && onWorkspaceViewModeChange && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onWorkspaceViewModeChange("list")}
              title="List view"
            >
              <List className="mr-1 h-3.5 w-3.5" />
              리스트
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCreateDialogOpen(true)}
            title="New folder"
          >
            <FolderPlus className="mr-1 h-3.5 w-3.5" />
            Folder
          </Button>
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setNewMenuOpen((open) => !open)}
              title="New"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              New
            </Button>
            {newMenuOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 w-36 rounded-md border border-border bg-popover p-1 shadow-lg">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    setNewMenuOpen(false);
                    openNewSessionModal("folder");
                  }}
                >
                  <Plus className="h-4 w-4" />
                  Session
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => createMarkdownAt()}
                >
                  <SquarePen className="h-4 w-4" />
                  문서
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={cn(
          "relative min-h-0 flex-1 overflow-auto",
          isSpaceDown && "cursor-grab",
          isPanning && "cursor-grabbing",
        )}
        style={DOT_GRID_STYLE}
        onPointerDown={handleCanvasPointerDown}
        onContextMenu={handleCanvasContextMenu}
      >
        <div
          data-testid="board-workspace-canvas"
          className="relative"
          style={{
            width: Math.max(canvasSize.width, BOARD_TILE_SIZE),
            height: Math.max(canvasSize.height, BOARD_TILE_SIZE),
          }}
        >
          {boardItems.length === 0 && (
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
                onTilePointerDown={handleTilePointerDown}
                shouldSuppressClick={shouldSuppressTileClick}
                onOpenFolder={selectFolder}
                onOpenMarkdown={(documentId) => {
                  setActiveBoardDocument(documentId);
                  if (isMobile) setActiveTab("chat");
                }}
                onOpenSession={(session) => {
                  setActiveSession(session.agentSessionId);
                  setActiveSessionSummary(session);
                  if (isMobile) setActiveTab("chat");
                }}
              />
            );
          })}

          {hasMore && onLoadMore && (
            <div
              ref={sentinelRef}
              data-testid="board-load-more-sentinel"
              className="absolute bottom-0 left-0 flex items-center justify-center py-3 text-xs text-muted-foreground"
              style={{ width: Math.max(canvasSize.width, BOARD_TILE_SIZE) }}
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

        {contextMenu && (
          <div
            className="fixed z-30 w-40 rounded-md border border-border bg-popover p-1 shadow-lg"
            style={{ left: contextMenu.screenX, top: contextMenu.screenY }}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => createMarkdownAt({ x: contextMenu.boardX, y: contextMenu.boardY })}
            >
              <SquarePen className="h-4 w-4" />
              새 문서
            </button>
          </div>
        )}
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
