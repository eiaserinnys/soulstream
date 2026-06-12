import type { CSSProperties, MutableRefObject, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { Loader2 } from "lucide-react";

import type { SessionSummary } from "../shared/types";
import { BoardWorkspaceTile } from "./BoardWorkspaceTile";
import { BoardWorkspaceChildPortal } from "./BoardWorkspaceChildPortal";
import { BOARD_CANVAS_ORIGIN_X, BOARD_CANVAS_ORIGIN_Y, BOARD_CANVAS_WIDTH, snapBoardPosition, type BoardWorkspaceItem, type SessionBoardWorkspaceItem } from "./board-workspace-items";
import type { BoardRect } from "./board-selection";
import type { DirectChildPortalItem, SessionParentRef } from "./board-session-relations";

interface BoardWorkspaceCanvasContentProps {
  isLoading: boolean;
  boardItems: BoardWorkspaceItem[];
  activeSessionKey: string | null;
  selectedBoardItemIds: Set<string>;
  pulseBoardItemId: string | null;
  expandedStackParentId: string | null;
  remoteSelectionByItemId: Map<string, string>;
  dragPreviews: Array<{ x: number; y: number }>;
  marqueeRect: BoardRect | null;
  hasMore?: boolean;
  onLoadMore?: unknown;
  sentinelRef: MutableRefObject<HTMLDivElement | null>;
  expandedParentItem: SessionBoardWorkspaceItem | null;
  expandedChildren: DirectChildPortalItem[];
  itemPosition: (item: BoardWorkspaceItem) => CSSProperties;
  boardToCanvasStyle: (position: { x: number; y: number }) => { left: number; top: number };
  onTilePointerDown: (event: ReactPointerEvent<HTMLElement>, item: BoardWorkspaceItem) => void;
  onTileContextMenu: (event: ReactMouseEvent<HTMLElement>, item: BoardWorkspaceItem) => void;
  shouldSuppressTileClick: () => boolean;
  onOpenFolder: (item: BoardWorkspaceItem, folderId: string) => void;
  onOpenMarkdown: (item: BoardWorkspaceItem, documentId: string) => void;
  onOpenSession: (session: SessionSummary, item?: BoardWorkspaceItem) => void;
  onToggleChildStack: (item: SessionBoardWorkspaceItem) => void;
  onNavigateToParent: (parentRef: SessionParentRef) => void;
  onOpenChildRef: (child: DirectChildPortalItem) => void;
  onToggleFrameCollapsed: (item: Extract<BoardWorkspaceItem, { type: "frame" }>) => void;
}

export function BoardWorkspaceCanvasContent({
  isLoading,
  boardItems,
  activeSessionKey,
  selectedBoardItemIds,
  pulseBoardItemId,
  expandedStackParentId,
  remoteSelectionByItemId,
  dragPreviews,
  marqueeRect,
  hasMore,
  onLoadMore,
  sentinelRef,
  expandedParentItem,
  expandedChildren,
  itemPosition,
  boardToCanvasStyle,
  onTilePointerDown,
  onTileContextMenu,
  shouldSuppressTileClick,
  onOpenFolder,
  onOpenMarkdown,
  onOpenSession,
  onToggleChildStack,
  onNavigateToParent,
  onOpenChildRef,
  onToggleFrameCollapsed,
}: BoardWorkspaceCanvasContentProps) {
  return (
    <>
      {isLoading && (
        <div className="absolute left-3 top-3 z-30 rounded-full border border-[var(--lg-line)] bg-[var(--lg-card)] p-2 shadow-[0_8px_26px_-18px_rgb(20_26_40_/_45%)]">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading board sync</span>
        </div>
      )}

      {boardItems.length === 0 && !isLoading && (
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
          isPulsing={pulseBoardItemId === item.boardItemId}
          isStackExpanded={item.type === "session" && expandedStackParentId === item.session.agentSessionId}
          remoteSelectionColor={remoteSelectionByItemId.get(item.boardItemId)}
          onTilePointerDown={onTilePointerDown}
          onTileContextMenu={onTileContextMenu}
          onToggleChildStack={onToggleChildStack}
          onNavigateToParent={onNavigateToParent}
          onToggleFrameCollapsed={onToggleFrameCollapsed}
          shouldSuppressClick={shouldSuppressTileClick}
          onOpenFolder={(folderId) => onOpenFolder(item, folderId)}
          onOpenMarkdown={(documentId) => onOpenMarkdown(item, documentId)}
          onOpenSession={(session) => onOpenSession(session, item)}
        />
      ))}

      {expandedParentItem && (
        <BoardWorkspaceChildPortal
          parentItem={expandedParentItem}
          children={expandedChildren}
          boardToCanvasStyle={boardToCanvasStyle}
          onOpenSession={onOpenSession}
          onOpenRef={onOpenChildRef}
        />
      )}

      {dragPreviews[0] && (
        <div
          data-testid="board-drag-ghost"
          className="pointer-events-none absolute z-20 h-[160px] w-[280px] rounded-[18px] border-2 border-dashed border-accent-blue/70 bg-accent-blue/10 opacity-50"
          style={boardToCanvasStyle(snapBoardPosition(dragPreviews[0].x, dragPreviews[0].y))}
        />
      )}

      {marqueeRect && (
        <div
          data-testid="board-marquee"
          className="pointer-events-none absolute z-30 rounded border border-accent-blue bg-accent-blue/10"
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
    </>
  );
}
