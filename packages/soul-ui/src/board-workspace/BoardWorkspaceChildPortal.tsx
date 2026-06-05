import { Folder, GitBranch, UserRound } from "lucide-react";

import type { SessionSummary } from "../shared/types";
import { STATUS_CONFIG } from "../components/SessionItem";
import { cn } from "../lib/cn";
import type { DirectChildPortalItem } from "./board-session-relations";
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
      className="absolute z-40 grid max-h-[360px] grid-cols-[repeat(auto-fit,minmax(72px,1fr))] gap-2 overflow-auto rounded-md border border-border bg-popover p-2 shadow-lg"
      style={{
        ...boardToCanvasStyle({
          x: parentItem.x + BOARD_TILE_WIDTH + 24,
          y: parentItem.y,
        }),
        width: children.length >= 20 ? 360 : Math.min(360, children.length * 104),
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
  const config = STATUS_CONFIG[child.session.status] ?? STATUS_CONFIG.unknown;
  return (
    <button
      type="button"
      data-testid="board-child-portal-card"
      data-session-id={child.session.agentSessionId}
      className="relative flex h-20 w-20 items-center justify-center rounded-md border border-border bg-card shadow-sm hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title="Open delegated child session"
      onDoubleClick={() => onOpenSession(child.session)}
    >
      <span
        className={cn("absolute right-2 top-2 h-2 w-2 rounded-full", config.dotClass)}
        aria-hidden="true"
      />
      {child.session.agentPortraitUrl ? (
        <img
          src={child.session.agentPortraitUrl}
          alt=""
          className="h-9 w-9 rounded-sm object-cover"
        />
      ) : (
        <span className="flex h-9 w-9 items-center justify-center rounded-sm border border-border bg-muted text-xs">
          {getAgentInitial(child.session)}
        </span>
      )}
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
      className="flex h-20 min-w-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-primary/50 bg-muted px-2 text-primary shadow-sm hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpenRef(child)}
    >
      <span className="relative flex h-8 w-8 items-center justify-center">
        <Folder className="h-7 w-7" aria-hidden="true" />
        <GitBranch className="absolute -right-1 -top-1 h-3.5 w-3.5 rounded-full bg-muted" aria-hidden="true" />
      </span>
      <span className="max-w-20 truncate text-[10px] font-medium">{child.folderName}</span>
      <UserRound className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}
