import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { FileText, Folder } from "lucide-react";

import type { SessionSummary } from "../shared/types";
import { Badge } from "../components/ui/badge";
import { BoardAssetCard } from "../components/BoardAssetCard";
import { STATUS_CONFIG } from "../components/SessionItem";
import { cn } from "../lib/cn";
import type { SessionParentRef } from "./board-session-relations";
import {
  formatBoardWorkspaceTime,
  getSessionBoardPreview,
  getSessionBoardTitle,
  type BoardWorkspaceItem,
} from "./board-workspace-items";

const BOARD_TILE_CLASS =
  "absolute z-10 flex h-[160px] w-[280px] touch-none select-none flex-col overflow-hidden rounded-md border border-border bg-card px-3 py-2 text-left shadow-sm transition-shadow hover:ring-1 hover:ring-ring/50 hover:ring-offset-1 hover:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
    event: ReactPointerEvent<HTMLElement>,
    item: BoardWorkspaceItem,
  ) => void;
  onOpenFolder: (folderId: string) => void;
  onOpenMarkdown: (documentId: string) => void;
  onOpenSession: (session: SessionSummary) => void;
  shouldSuppressClick: () => boolean;
  isSelected: boolean;
  remoteSelectionColor?: string;
  onTileContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    item: BoardWorkspaceItem,
  ) => void;
  isStackExpanded?: boolean;
  isPulsing?: boolean;
  onToggleChildStack?: (item: Extract<BoardWorkspaceItem, { type: "session" }>) => void;
  onNavigateToParent?: (parentRef: SessionParentRef) => void;
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
  remoteSelectionColor,
  onTileContextMenu,
  isStackExpanded,
  isPulsing,
  onToggleChildStack,
  onNavigateToParent,
}: BoardWorkspaceTileProps) {
  const tileClassName = cn(
    BOARD_TILE_CLASS,
    isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
    remoteSelectionColor && !isSelected && "ring-2 ring-[var(--board-remote-ring)] ring-offset-2 ring-offset-background",
    isPulsing && "animate-pulse ring-2 ring-primary ring-offset-2 ring-offset-background",
  );
  const tileStyle = {
    ...style,
    ...(remoteSelectionColor ? { "--board-remote-ring": remoteSelectionColor } : {}),
  } as CSSProperties;

  if (item.type === "folder") {
    return (
      <button
        key={item.id}
        type="button"
        data-testid="board-folder-tile"
        data-board-tile="true"
        className={tileClassName}
        style={tileStyle}
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
        style={tileStyle}
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

  if (item.type === "asset") {
    return (
      <div
        key={item.id}
        role="button"
        tabIndex={0}
        data-testid="board-asset-tile"
        data-board-tile="true"
        className={cn(tileClassName, "h-[200px]")}
        style={tileStyle}
        onPointerDown={(event) => onTilePointerDown(event, item)}
        onContextMenu={(event) => onTileContextMenu(event, item)}
      >
        <BoardAssetCard
          fileName={item.fileName}
          mimeType={item.mimeType}
          byteSize={item.byteSize}
          signedUrl={item.signedUrl}
          sourceUrl={item.sourceUrl}
          uploadProgress={item.uploadProgress}
          uploadState={item.uploadState}
          errorMessage={item.errorMessage}
        />
      </div>
    );
  }

  const config = STATUS_CONFIG[item.session.status] ?? STATUS_CONFIG.unknown;
  const activityTime =
    item.session.lastMessage?.timestamp ?? item.session.updatedAt ?? item.session.createdAt;
  const stackStatus = item.childStack?.status;
  return (
    <button
      key={item.id}
      type="button"
      data-testid="board-session-tile"
      data-board-tile="true"
      data-session-id={item.session.agentSessionId}
      className={cn(
        tileClassName,
        activeSessionKey === item.session.agentSessionId &&
          !isSelected &&
          !remoteSelectionColor &&
          "ring-1 ring-ring ring-offset-2 ring-offset-background",
        stackStatus === "running" &&
          "animate-[pulse_1.5s_ease-in-out_infinite] ring-2 ring-success ring-offset-2 ring-offset-background shadow-md",
        stackStatus === "error" &&
          "ring-2 ring-accent-red ring-offset-2 ring-offset-background shadow-md",
      )}
      style={tileStyle}
      onPointerDown={(event) => onTilePointerDown(event, item)}
      onContextMenu={(event) => onTileContextMenu(event, item)}
      onClick={() => {
        if (shouldSuppressClick()) return;
        onOpenSession(item.session);
      }}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        {item.childStack && (
          <span
            role="button"
            tabIndex={0}
            data-testid="board-session-child-stack-badge"
            className={cn(
              "absolute right-0 top-0 z-10 inline-flex h-5 min-w-8 items-center justify-center gap-0.5 rounded border border-border bg-card px-1 text-[10px] font-semibold text-muted-foreground shadow-sm transition-[border-color,box-shadow,color,opacity] duration-200",
              isStackExpanded && "border-primary text-primary ring-1 ring-primary",
              stackStatus === "running" &&
                "animate-[pulse_1.5s_ease-in-out_infinite] border-success text-success ring-1 ring-success",
              stackStatus === "error" &&
                "border-accent-red text-accent-red ring-1 ring-accent-red",
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleChildStack?.(item);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onToggleChildStack?.(item);
            }}
          >
            <span aria-hidden="true">⤷</span>
            {item.childStack.count}
          </span>
        )}
        {item.parentRef && (
          <span
            role={item.parentRef.parentAvailable ? "button" : undefined}
            tabIndex={item.parentRef.parentAvailable ? 0 : undefined}
            data-testid="board-session-parent-ref-badge"
            className={cn(
              "absolute left-0 top-0 z-10 inline-flex h-5 max-w-32 items-center gap-0.5 rounded border border-border bg-card px-1 text-[10px] font-medium shadow-sm",
              item.parentRef.parentAvailable
                ? "text-muted-foreground hover:border-primary hover:text-primary"
                : "cursor-not-allowed text-muted-foreground/50",
            )}
            onClick={(event) => {
              if (!item.parentRef?.parentAvailable) return;
              event.preventDefault();
              event.stopPropagation();
              onNavigateToParent?.(item.parentRef);
            }}
            onKeyDown={(event) => {
              if (!item.parentRef?.parentAvailable) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onNavigateToParent?.(item.parentRef);
            }}
          >
            <span className="shrink-0" aria-hidden="true">↩</span>
            <span className="truncate">{item.parentRef.parentFolderName}</span>
          </span>
        )}
        <span
          className={cn(
            "absolute h-2.5 w-2.5 rounded-full",
            item.childStack ? "right-0 top-7" : "right-0 top-0",
            config.dotClass,
            config.animate && "animate-[pulse_2s_infinite]",
          )}
          aria-hidden="true"
        />
        <div
          data-testid="board-session-title"
          className={cn(
            "line-clamp-2 pr-4 text-sm font-medium leading-snug",
            item.parentRef && "pt-6",
            item.childStack && "pr-10",
          )}
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
                className="h-5 w-5 shrink-0 rounded-sm object-cover"
              />
            ) : (
              <span
                data-testid="board-session-agent-avatar"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-border bg-muted text-[9px]"
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
            className="line-clamp-3 min-w-0 text-xs leading-snug text-muted-foreground"
          >
            {getSessionBoardPreview(item.session)}
          </div>
        </div>
      </div>
    </button>
  );
}
