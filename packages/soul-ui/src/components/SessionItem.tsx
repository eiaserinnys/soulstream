/**
 * SessionItem - 폴더 내 세션 목록에서 개별 세션 행을 렌더링하는 컴포넌트.
 *
 * DnD 핸들, 포트레이트, 상태 뱃지, 인라인 이름 편집을 담당한다.
 * 가상 스크롤/컨텍스트 메뉴/FLIP 애니메이션은 상위 FolderContents에서 처리한다.
 */

import { memo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { isSessionUnread } from "../stores/dashboard-store";
import { cn } from "../lib/cn";
import { Badge } from "./ui/badge";
import { NodeBadge } from "./NodeBadge";
import { BackendBadge } from "./BackendBadge";
import type { SessionSummary, SessionStatus } from "../shared/types";

// === Status Config ===

export interface StatusConfig {
  dotClass: string;
  animate: boolean;
}

export const STATUS_CONFIG: Record<SessionStatus, StatusConfig> = {
  running:      { dotClass: "bg-success",          animate: true  },
  completed:    { dotClass: "bg-muted-foreground",  animate: false },
  error:        { dotClass: "bg-accent-red",        animate: false },
  interrupted:  { dotClass: "bg-accent-amber",      animate: false },
  unknown:      { dotClass: "bg-muted-foreground",  animate: false },
};

// === Portrait ===

function SessionPortrait({ url }: { url: string }) {
  const [error, setError] = useState(false);
  if (error) return null;
  return (
    <div className="h-10 w-10 shrink-0 rounded-full overflow-hidden">
      <img
        src={url}
        alt=""
        className="w-full h-full object-cover"
        onError={() => setError(true)}
      />
    </div>
  );
}

// === SessionItem ===

export interface SessionItemProps {
  session: SessionSummary;
  isActive: boolean;
  isSelected: boolean;
  isEditing: boolean;
  /** DnD 시 전달할 세션 ID 목록 (다중 선택 포함) */
  dragSessionIds: string[];
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onEditSubmit: (name: string) => void;
  onEditCancel: () => void;
}

export const SessionItem = memo(function SessionItem({
  session,
  isActive,
  isSelected,
  isEditing,
  dragSessionIds,
  onClick,
  onContextMenu,
  onEditSubmit,
  onEditCancel,
}: SessionItemProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: session.agentSessionId,
    data: { type: "session", sessionIds: dragSessionIds },
  });

  const config = STATUS_CONFIG[session.status] ?? STATUS_CONFIG.unknown;
  const isUnread = isSessionUnread(session);
  const isReadCompleted = session.status === "completed" && !isUnread;

  const displayText = session.displayName
    ? `📌 ${session.displayName}`
    : session.lastMessage?.preview
      ? `🗨️ ${session.lastMessage.preview}`
      : session.prompt || session.agentSessionId;

  const displayTime = session.lastMessage?.timestamp ?? session.updatedAt ?? session.createdAt;
  const timeStr = displayTime
    ? new Date(displayTime).toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "...";

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-testid="draggable-session"
      className={cn(
        "flex items-center gap-2 px-3 py-2 cursor-pointer text-sm hover:bg-accent/50 border-b border-border/50 select-none transition-[background-color] duration-200 ease-out",
        isActive && "bg-accent text-accent-foreground",
        isSelected && !isActive && "bg-primary/10",
        isReadCompleted && "opacity-50",
        isDragging && "opacity-50",
      )}
      onClick={onClick}
      onContextMenu={onContextMenu}
      data-session-id={session.agentSessionId}
    >
      <span
        className={cn(
          "w-2 h-2 rounded-full shrink-0",
          config.dotClass,
          config.animate && "animate-[pulse_2s_infinite]",
        )}
      />
      {session.agentPortraitUrl && (
        <SessionPortrait url={session.agentPortraitUrl} />
      )}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            autoFocus
            className="w-full bg-transparent border-b border-primary outline-none text-sm"
            defaultValue={session.displayName ?? ""}
            onBlur={(e) => onEditSubmit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditSubmit((e.target as HTMLInputElement).value);
              if (e.key === "Escape") onEditCancel();
            }}
          />
        ) : (
          <div className={cn("truncate", isUnread ? "text-foreground font-semibold" : isReadCompleted ? "text-muted-foreground" : "text-foreground")}>
            {displayText}
          </div>
        )}
        <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
          {session.agentName && (
            <>
              <span className="shrink-0 text-xs opacity-70">{session.agentName}</span>
              <span className="shrink-0 opacity-50">·</span>
            </>
          )}
          <span>{timeStr}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {session.backend && (
          <BackendBadge backend={session.backend} className="shrink-0" />
        )}
        {session.nodeId && <NodeBadge nodeId={session.nodeId} className="shrink-0" />}
        {session.eventCount > 0 && (
          <Badge variant="outline" size="sm" className="shrink-0">
            {session.eventCount}
          </Badge>
        )}
      </div>
    </div>
  );
});
