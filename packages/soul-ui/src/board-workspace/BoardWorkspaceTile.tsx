import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Code2, FileText, Folder, Frame } from "lucide-react";

import type { SessionSummary } from "../shared/types";
import { Badge } from "../components/ui/badge";
import { BoardAssetCard } from "../components/BoardAssetCard";
import { STATUS_CONFIG } from "../components/SessionItem";
import { cn } from "../lib/cn";
import { CustomViewTileBody } from "../custom-view/CustomViewTileBody";
import { RunbookCard } from "../runbook/RunbookCard";
import type { SessionParentRef } from "./board-session-relations";
import {
  formatBoardWorkspaceTime,
  getSessionBoardPreview,
  getSessionBoardTitle,
  type BoardWorkspaceItem,
} from "./board-workspace-items";

const BOARD_TILE_CLASS =
  "absolute z-10 flex h-[160px] w-[280px] touch-none select-none flex-col overflow-hidden rounded-[18px] border border-white/8 bg-[var(--lg-card)] px-4 py-[13px] text-left text-sm shadow-[0_10px_30px_-14px_rgb(10_16_30_/_50%)] transition-[border-color,box-shadow,opacity,outline-color] duration-200 ease-out hover:border-accent-blue/35 hover:shadow-[0_12px_32px_-18px_rgb(10_30_70_/_50%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50";

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
  onOpenRunbookBoard: (runbookId: string) => void;
  onOpenMarkdown: (documentId: string) => void;
  onOpenCustomView: (customViewId: string) => void;
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
  onToggleFrameCollapsed?: (item: Extract<BoardWorkspaceItem, { type: "frame" }>) => void;
}

export function BoardWorkspaceTile({
  item,
  style,
  activeSessionKey,
  onTilePointerDown,
  onOpenFolder,
  onOpenRunbookBoard,
  onOpenMarkdown,
  onOpenCustomView,
  onOpenSession,
  shouldSuppressClick,
  isSelected,
  remoteSelectionColor,
  onTileContextMenu,
  isStackExpanded,
  isPulsing,
  onToggleChildStack,
  onNavigateToParent,
  onToggleFrameCollapsed,
}: BoardWorkspaceTileProps) {
  const selectionClassName = cn(
    isSelected && "outline outline-2 outline-offset-[1px] outline-accent-blue",
    remoteSelectionColor && !isSelected && "outline outline-2 outline-offset-[1px] outline-[var(--board-remote-ring)]",
  );
  const pulsingClassName =
    isPulsing && "animate-pulse outline outline-2 outline-offset-[1px] outline-accent-blue";
  const tileClassName = cn(
    BOARD_TILE_CLASS,
    selectionClassName,
    pulsingClassName,
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
          <Folder className="h-12 w-12 shrink-0 text-accent-blue" />
          <Badge variant="secondary" className="absolute right-0 top-0 min-w-5 justify-center rounded-full px-1 text-[10px]">
            {item.childCount}
          </Badge>
        </div>
        <div className="flex h-[40%] min-w-0 flex-col justify-end border-t border-[var(--lg-line)] pt-2">
          <div data-testid="board-folder-title" className="truncate text-[13.5px] font-semibold leading-[1.45]">
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
        <div className="flex items-center gap-2 border-b border-[var(--lg-line)] pb-2">
          <FileText className="h-5 w-5 shrink-0 text-accent-blue" />
          <span data-testid="board-markdown-title" className="line-clamp-2 text-[13.5px] font-semibold leading-snug">
            {item.title}
          </span>
        </div>
        <div data-testid="board-markdown-preview" className="mt-2 line-clamp-3 text-xs leading-[1.55] text-muted-foreground">
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

  if (item.type === "custom_view") {
    // 커스텀 뷰는 풀블리드 위젯 — 타일 크롬(패딩·헤더) 없이 캔버스 전체를
    // 에이전트 저작 HTML이 쓴다. 타이틀·revision은 호버 오버레이로만.
    return (
      <button
        key={item.id}
        type="button"
        data-testid="board-custom-view-tile"
        data-board-tile="true"
        className={cn(tileClassName, "group p-0")}
        style={tileStyle}
        onPointerDown={(event) => onTilePointerDown(event, item)}
        onContextMenu={(event) => onTileContextMenu(event, item)}
        onClick={() => {
          if (shouldSuppressClick()) return;
          onOpenCustomView(item.customViewId);
        }}
      >
        <CustomViewTileBody
          customViewId={item.customViewId}
          title={item.title}
          fallbackPreview={item.preview}
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/45 to-transparent px-3 pb-4 pt-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <Code2 className="h-4 w-4 shrink-0 text-white/85" />
          <span data-testid="board-custom-view-title" className="min-w-0 flex-1 truncate text-left text-[12.5px] font-semibold text-white/90">
            {item.title}
          </span>
          <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">
            r{item.revision}
          </Badge>
        </div>
      </button>
    );
  }

  if (item.type === "frame") {
    const frameRunningClassName = item.hasRunningChild && [
      "border-transparent card-running-base",
      "card-running",
    ];
    if (item.collapsed) {
      return (
        <button
          key={item.id}
          type="button"
          data-testid="board-frame-tile"
          data-board-tile="true"
          className={cn(tileClassName, frameRunningClassName)}
          style={tileStyle}
          onPointerDown={(event) => onTilePointerDown(event, item)}
          onContextMenu={(event) => onTileContextMenu(event, item)}
          onClick={() => {
            if (shouldSuppressClick()) return;
            onToggleFrameCollapsed?.(item);
          }}
        >
          <div className="flex items-center gap-2 border-b border-[var(--lg-line)] pb-2">
            <Frame className="h-5 w-5 shrink-0 text-accent-blue" />
            <span data-testid="board-frame-title" className="line-clamp-2 text-sm font-medium leading-snug">
              {item.title}
            </span>
          </div>
          <div className="mt-auto flex items-center justify-between border-t border-[var(--lg-line)] pt-2 text-xs text-muted-foreground">
            <span data-testid="board-frame-summary">{item.childCount} cards</span>
            {item.hasRunningChild && (
              <Badge variant="secondary" className="border-success text-success">
                running
              </Badge>
            )}
          </div>
        </button>
      );
    }

    return (
      <div
        key={item.id}
        role="button"
        tabIndex={0}
        data-testid="board-frame-region"
        data-board-tile="true"
        className={cn(
          "absolute z-0 flex touch-none select-none flex-col rounded-[18px] border border-dashed border-accent-blue/45 bg-accent-blue/[0.04] text-left shadow-[0_10px_30px_-18px_rgb(10_30_70_/_45%)] transition-[border-color,box-shadow] hover:border-accent-blue/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50",
          selectionClassName,
          pulsingClassName,
        )}
        style={{ ...tileStyle, width: item.width, height: item.height }}
        onPointerDown={(event) => onTilePointerDown(event, item)}
        onContextMenu={(event) => onTileContextMenu(event, item)}
      >
        <div className="flex h-8 min-w-0 items-center gap-2 rounded-t-[17px] bg-[var(--lg-card)] px-2 text-xs font-medium text-accent-blue shadow-sm">
          <Frame className="h-4 w-4 shrink-0" />
          <span data-testid="board-frame-title" className="truncate">{item.title}</span>
          <Badge variant="secondary" className="ml-auto h-5 px-1 text-[10px]">
            {item.childCount}
          </Badge>
        </div>
      </div>
    );
  }

  if (item.type === "runbook") {
    return (
      <div
        key={item.id}
        role="group"
        tabIndex={0}
        data-testid="board-runbook-tile"
        data-board-tile="true"
        className={cn(BOARD_TILE_CLASS, "h-[360px] w-[360px] p-0", selectionClassName, pulsingClassName)}
        style={tileStyle}
        onPointerDown={(event) => onTilePointerDown(event, item)}
        onContextMenu={(event) => onTileContextMenu(event, item)}
        onClick={(event) => event.stopPropagation()}
      >
        <RunbookCard
          runbookId={item.runbookId}
          fallbackTitle={item.title}
          onOpenBoard={onOpenRunbookBoard}
        />
      </div>
    );
  }

  if (item.type !== "session") {
    return assertNever(item);
  }

  const config = STATUS_CONFIG[item.session.status] ?? STATUS_CONFIG.unknown;
  const activityTime =
    item.session.lastMessage?.timestamp ?? item.session.updatedAt ?? item.session.createdAt;
  const stackStatus = item.childStack?.status;
  const isSessionRunning = item.session.status === "running";
  const isSessionActive = activeSessionKey === item.session.agentSessionId;
  return (
    <button
      key={item.id}
      type="button"
      data-testid="board-session-tile"
      data-board-tile="true"
      data-session-id={item.session.agentSessionId}
      className={cn(
        BOARD_TILE_CLASS,
        selectionClassName,
        !isSessionRunning && pulsingClassName,
        isSessionRunning && [
          "border-transparent card-running-base",
          isSessionActive ? "card-running-active" : "card-running",
        ],
        isSessionActive &&
          !isSelected &&
          !remoteSelectionColor &&
          !isSessionRunning &&
          "outline outline-1 outline-offset-[1px] outline-accent-blue/50",
        stackStatus === "error" &&
          "outline outline-2 outline-offset-[1px] outline-accent-red shadow-md",
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
              "absolute right-0 top-0 z-10 inline-flex h-5 min-w-8 items-center justify-center gap-0.5 overflow-hidden rounded-full border border-[var(--lg-line)] bg-muted/40 px-1 text-[10px] font-semibold text-muted-foreground shadow-sm transition-[border-color,box-shadow,color,opacity] duration-200",
              isStackExpanded && "border-accent-blue text-accent-blue ring-1 ring-accent-blue",
              stackStatus === "running" &&
                "card-running-base card-running border-success text-success ring-1 ring-success",
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
              "absolute left-0 top-0 z-10 inline-flex h-5 max-w-32 items-center gap-0.5 rounded-full border border-[var(--lg-line)] bg-muted/40 px-1 text-[10px] font-medium shadow-sm",
              item.parentRef.parentAvailable
                ? "text-muted-foreground hover:border-accent-blue hover:text-accent-blue"
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
        {!isSessionRunning && (
          <span
            data-testid="board-session-status-dot"
            className={cn(
              "absolute h-2.5 w-2.5 rounded-full",
              item.childStack ? "right-0 top-7" : "right-0 top-0",
              config.dotClass,
              config.animate && "animate-[pulse_2s_infinite]",
            )}
            aria-hidden="true"
          />
        )}
        <div
          data-testid="board-session-title"
          className={cn(
            "line-clamp-2 text-sm font-medium leading-snug",
            !isSessionRunning && "pr-4",
            item.parentRef && "pt-6",
            item.childStack && "pr-10",
          )}
        >
          {getSessionBoardTitle(item.session)}
        </div>
        <div className="mt-auto min-w-0 border-t border-[var(--lg-line)] pt-2">
          <div
            data-testid="board-session-agent"
            className="mb-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            {item.session.agentPortraitUrl ? (
              <img
                data-testid="board-session-agent-avatar"
                src={item.session.agentPortraitUrl}
                alt={getSessionAgentLabel(item.session)}
                className="h-5 w-5 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span
                data-testid="board-session-agent-avatar"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--lg-line)] bg-muted/40 text-[9px]"
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

function assertNever(value: never): never {
  throw new Error(`Unhandled board workspace item: ${JSON.stringify(value)}`);
}
