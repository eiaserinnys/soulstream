import { Folder, GitBranch, UserRound } from "lucide-react";

import type { SessionSummary } from "../shared/types";
import { STATUS_CONFIG } from "../components/SessionItem";
import { cn } from "../lib/cn";
import type { DirectChildPortalItem } from "./board-session-relations";
import {
  getChildSessionFirstLine,
  getChildSessionLastLine,
} from "./board-session-relations";
import {
  BOARD_TILE_WIDTH,
  type SessionBoardWorkspaceItem,
} from "./board-workspace-items";

interface BoardWorkspaceChildPortalProps {
  parentItem: SessionBoardWorkspaceItem;
  children: DirectChildPortalItem[];
  boardToCanvasStyle: (position: { x: number; y: number }) => { left: number; top: number };
  onOpenSession: (session: SessionSummary) => void;
  onOpenRef: (child: DirectChildPortalItem) => void;
}

function getAgentInitial(session: SessionSummary): string {
  const label = session.agentName?.trim() || session.agentId?.trim() || "A";
  return Array.from(label)[0]?.toUpperCase() ?? "A";
}

export function BoardWorkspaceChildPortal({
  parentItem,
  children,
  boardToCanvasStyle,
  onOpenSession,
  onOpenRef,
}: BoardWorkspaceChildPortalProps) {
  if (children.length === 0) return null;
  return (
    <div
      data-testid="board-child-portal"
      className="absolute z-40 flex max-h-[360px] flex-col gap-2 overflow-auto rounded-[18px] border border-white/8 bg-[var(--lg-card)] p-2 shadow-[0_10px_30px_-14px_rgb(10_16_30_/_50%)]"
      style={{
        ...boardToCanvasStyle({
          x: parentItem.x + BOARD_TILE_WIDTH + 24,
          y: parentItem.y,
        }),
        width: BOARD_TILE_WIDTH + 18,
      }}
    >
      {children.map((child) =>
        child.isSameFolder ? (
          <SameFolderChildCard
            key={child.session.agentSessionId}
            child={child}
            onOpenSession={onOpenSession}
          />
        ) : (
          <RefChildCard
            key={child.session.agentSessionId}
            child={child}
            onOpenRef={onOpenRef}
          />
        ),
      )}
    </div>
  );
}

function SameFolderChildCard({
  child,
  onOpenSession,
}: {
  child: DirectChildPortalItem;
  onOpenSession: (session: SessionSummary) => void;
}) {
  return (
    <button
      type="button"
      data-testid="board-child-portal-card"
      data-session-id={child.session.agentSessionId}
      className={childCardClassName(child)}
      title="Open delegated child session"
      onClick={() => onOpenSession(child.session)}
    >
      <ChildCardContent child={child} kind="same" />
    </button>
  );
}

function RefChildCard({
  child,
  onOpenRef,
}: {
  child: DirectChildPortalItem;
  onOpenRef: (child: DirectChildPortalItem) => void;
}) {
  return (
    <button
      type="button"
      data-testid="board-child-ref-card"
      data-session-id={child.session.agentSessionId}
      className={cn(childCardClassName(child), "border-dashed")}
      onClick={() => onOpenRef(child)}
    >
      <ChildCardContent child={child} kind="ref" />
    </button>
  );
}

function childCardClassName(child: DirectChildPortalItem): string {
  return cn(
    "relative flex h-24 w-[280px] items-stretch gap-2 rounded-[14px] border border-[var(--lg-line)] bg-muted/30 p-2 text-left shadow-sm transition-[border-color,box-shadow,color,opacity] duration-200 hover:border-accent-blue/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/50",
    child.session.status === "running" &&
      "animate-[pulse_1.5s_ease-in-out_infinite] ring-1 ring-success",
    child.session.status === "error" &&
      "ring-1 ring-accent-red",
  );
}

function ChildCardContent({
  child,
  kind,
}: {
  child: DirectChildPortalItem;
  kind: "same" | "ref";
}) {
  const config = STATUS_CONFIG[child.session.status] ?? STATUS_CONFIG.unknown;
  const firstLine = getChildSessionFirstLine(child.session);
  const lastLine = getChildSessionLastLine(child.session);
  return (
    <>
      <span
        className={cn("absolute right-2 top-2 h-2 w-2 rounded-full", config.dotClass)}
        aria-hidden="true"
      />
      <span className="flex h-full w-11 shrink-0 items-center justify-center">
        {kind === "ref" ? (
          <span className="relative flex h-9 w-9 items-center justify-center text-accent-blue">
            <Folder className="h-8 w-8" aria-hidden="true" />
            <GitBranch className="absolute -right-1 -top-1 h-3.5 w-3.5 rounded-full bg-[var(--lg-card)]" aria-hidden="true" />
          </span>
        ) : child.session.agentPortraitUrl ? (
          <img
            src={child.session.agentPortraitUrl}
            alt=""
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--lg-line)] bg-muted/40 text-xs">
            {getAgentInitial(child.session)}
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1 pr-3">
        {kind === "ref" && (
          <span className="flex min-w-0 items-center gap-1 text-[10px] font-medium text-accent-blue">
            <UserRound className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{child.folderName}</span>
          </span>
        )}
        <span
          data-testid="board-child-first-message"
          className="truncate text-xs font-medium text-foreground"
        >
          {firstLine}
        </span>
        <span
          data-testid="board-child-last-message"
          className={cn(
            "truncate text-[11px] leading-snug text-muted-foreground",
            child.session.status === "running" &&
              "animate-[pulse_1.5s_ease-in-out_infinite]",
            child.session.status === "error" && "text-accent-red",
          )}
        >
          {lastLine}
        </span>
      </span>
    </>
  );
}
