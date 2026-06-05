import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { FileText, Folder } from "lucide-react";

import type { SessionSummary } from "../shared/types";
import { Badge } from "../components/ui/badge";
import { STATUS_CONFIG } from "../components/SessionItem";
import { cn } from "../lib/cn";
import {
  formatBoardWorkspaceTime,
  getSessionBoardPreview,
  getSessionBoardTitle,
  type BoardWorkspaceItem,
} from "./board-workspace-items";

const BOARD_TILE_CLASS =
  "absolute z-10 flex h-[120px] w-[160px] touch-none select-none flex-col overflow-hidden rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function getSessionAgentLabel(session: SessionSummary): string {
  return session.agentName?.trim() || session.agentId?.trim() || "—";
}

function getAgentInitial(label: string): string {
  if (label === "—") return "—";
  return Array.from(label)[0]?.toUpperCase() ?? "A";
}

interface BoardWorkspaceTileProps {
  item: BoardWorkspaceItem;
  style: CSSProperties;
  activeSessionKey: string | null;
  onTilePointerDown: (
    event: ReactPointerEvent<HTMLButtonElement>,
    item: BoardWorkspaceItem,
  ) => void;
  onOpenFolder: (folderId: string) => void;
  onOpenMarkdown: (documentId: string) => void;
  onOpenSession: (session: SessionSummary) => void;
  shouldSuppressClick: () => boolean;
  isSelected: boolean;
  onTileContextMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    item: BoardWorkspaceItem,
  ) => void;
}

export function BoardWorkspaceTile({
  item,
  style,
  activeSessionKey,
  onTilePointerDown,
  onOpenFolder,
  onOpenMarkdown,
  onOpenSession,
  shouldSuppressClick,
  isSelected,
  onTileContextMenu,
}: BoardWorkspaceTileProps) {
  const tileClassName = cn(
    BOARD_TILE_CLASS,
    isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
  );

  if (item.type === "folder") {
    return (
      <button
        key={item.id}
        type="button"
        data-testid="board-folder-tile"
        data-board-tile="true"
        className={tileClassName}
        style={style}
        onPointerDown={(event) => onTilePointerDown(event, item)}
        onContextMenu={(event) => onTileContextMenu(event, item)}
        onClick={() => {
          if (shouldSuppressClick()) return;
          onOpenFolder(item.folder.id);
        }}
      >
        <div className="relative flex h-[60%] items-center justify-center">
          <Folder className="h-12 w-12 shrink-0 text-primary" />
          <Badge variant="secondary" className="absolute right-0 top-0 min-w-5 justify-center px-1 text-[10px]">
            {item.childCount}
          </Badge>
        </div>
        <div className="flex h-[40%] min-w-0 flex-col justify-end border-t border-border/60 pt-2">
          <div data-testid="board-folder-title" className="truncate text-sm font-medium">
            {item.folder.name}
          </div>
        </div>
      </button>
    );
  }

  if (item.type === "markdown") {
    return (
      <button
        key={item.id}
        type="button"
        data-testid="board-markdown-tile"
        data-board-tile="true"
        className={tileClassName}
        style={style}
        onPointerDown={(event) => onTilePointerDown(event, item)}
        onContextMenu={(event) => onTileContextMenu(event, item)}
        onClick={() => {
          if (shouldSuppressClick()) return;
          onOpenMarkdown(item.documentId);
        }}
      >
        <div className="flex items-center gap-2 border-b border-border/60 pb-2">
          <FileText className="h-5 w-5 shrink-0 text-primary" />
          <span data-testid="board-markdown-title" className="line-clamp-2 text-sm font-medium leading-snug">
            {item.title}
          </span>
        </div>
        <div data-testid="board-markdown-preview" className="mt-2 line-clamp-3 text-xs leading-snug text-muted-foreground">
          {item.preview || "Empty document"}
        </div>
      </button>
    );
  }

  const config = STATUS_CONFIG[item.session.status] ?? STATUS_CONFIG.unknown;
  const activityTime =
    item.session.lastMessage?.timestamp ?? item.session.updatedAt ?? item.session.createdAt;
  return (
    <button
      key={item.id}
      type="button"
      data-testid="board-session-tile"
      data-board-tile="true"
      data-session-id={item.session.agentSessionId}
      className={cn(
        tileClassName,
        activeSessionKey === item.session.agentSessionId && "bg-accent text-accent-foreground",
      )}
      style={style}
      onPointerDown={(event) => onTilePointerDown(event, item)}
      onContextMenu={(event) => onTileContextMenu(event, item)}
      onClick={() => {
        if (shouldSuppressClick()) return;
        onOpenSession(item.session);
      }}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <span
          className={cn(
            "absolute right-0 top-0 h-2.5 w-2.5 rounded-full",
            config.dotClass,
            config.animate && "animate-[pulse_2s_infinite]",
          )}
          aria-hidden="true"
        />
        <div
          data-testid="board-session-title"
          className="line-clamp-3 pr-4 text-sm font-medium leading-snug"
        >
          {getSessionBoardTitle(item.session)}
        </div>
        <div className="mt-auto min-w-0 border-t border-border/60 pt-2">
          <div
            data-testid="board-session-agent"
            className="mb-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            {item.session.agentPortraitUrl ? (
              <img
                data-testid="board-session-agent-avatar"
                src={item.session.agentPortraitUrl}
                alt={getSessionAgentLabel(item.session)}
                className="h-4 w-4 shrink-0 rounded-sm object-cover"
              />
            ) : (
              <span
                data-testid="board-session-agent-avatar"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-border bg-muted text-[9px]"
              >
                {getAgentInitial(getSessionAgentLabel(item.session))}
              </span>
            )}
            <span className="truncate">{getSessionAgentLabel(item.session)}</span>
            <span className="shrink-0 text-muted-foreground/60">·</span>
            <span className="shrink-0">{formatBoardWorkspaceTime(activityTime)}</span>
          </div>
          <div
            data-testid="board-session-preview"
            className="line-clamp-2 min-w-0 text-xs leading-snug text-muted-foreground"
          >
            {getSessionBoardPreview(item.session)}
          </div>
        </div>
      </div>
    </button>
  );
}
