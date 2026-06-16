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
import { LiquidGlassCard } from "./LiquidGlassCard";
import type { SessionSummary, SessionStatus } from "../shared/types";

// === Status Config ===

export interface StatusConfig {
  dotClass: string;
  animate: boolean;
  label: string;
  chipClass: string;
}

export const STATUS_CONFIG: Record<SessionStatus, StatusConfig> = {
  running:      { dotClass: "bg-success",          animate: true,  label: "실행 중", chipClass: "bg-success/13 text-success" },
  completed:    { dotClass: "bg-muted-foreground",  animate: false, label: "완료", chipClass: "bg-muted text-muted-foreground" },
  error:        { dotClass: "bg-accent-red",        animate: false, label: "오류", chipClass: "bg-accent-red/10 text-accent-red" },
  interrupted:  { dotClass: "bg-accent-amber",      animate: false, label: "중단", chipClass: "bg-accent-amber/14 text-accent-amber" },
  unknown:      { dotClass: "bg-muted-foreground",  animate: false, label: "대기", chipClass: "bg-accent-amber/14 text-accent-amber" },
};

// === Portrait ===

function getInitials(name: string | null | undefined): string {
  const source = name?.trim();
  if (!source) return "?";
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function SessionPortrait({ url, name }: { url?: string | null; name?: string | null }) {
  const [error, setError] = useState(false);
  if (!url || error) {
    return (
      <span className="flex h-[25px] w-[25px] shrink-0 items-center justify-center rounded-full border border-white/20 bg-muted text-xs font-semibold text-muted-foreground">
        {getInitials(name)}
      </span>
    );
  }
  return (
    <div className="h-[25px] w-[25px] shrink-0 overflow-hidden rounded-full shadow-[0_0_0_1px_rgb(255_255_255_/_18%)]">
      <img
        src={url}
        alt={name ?? ""}
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
    ? session.displayName
    : session.lastMessage?.preview
      ? session.lastMessage.preview
      : session.prompt || session.agentSessionId;
  const previewText =
    session.lastMessage?.preview && session.lastMessage.preview !== displayText
      ? session.lastMessage.preview
      : session.prompt && session.prompt !== displayText
        ? session.prompt
        : null;

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
    <LiquidGlassCard
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      webglSurface
      data-testid="draggable-session"
      className={cn(
        "group flex h-full cursor-pointer select-none flex-col gap-2 rounded-[18px] border border-white/8 px-4 py-[13px] text-sm shadow-[0_8px_26px_-18px_rgb(20_26_40_/_45%)] transition-[border-color,box-shadow,opacity,transform] duration-200 ease-out",
        "hover:border-accent-blue/35 hover:shadow-[0_12px_32px_-18px_rgb(10_30_70_/_50%)]",
        isActive && "border-accent-blue/55 ring-1 ring-accent-blue/50",
        isSelected && !isActive && "border-accent-blue/35 ring-1 ring-accent-blue/25",
        isReadCompleted && "opacity-50",
        isDragging && "opacity-50",
      )}
      onClick={onClick}
      onContextMenu={onContextMenu}
      data-session-id={session.agentSessionId}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <input
              autoFocus
              className="w-full border-b border-primary bg-transparent text-sm outline-none"
              defaultValue={session.displayName ?? ""}
              onBlur={(e) => onEditSubmit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onEditSubmit((e.target as HTMLInputElement).value);
                if (e.key === "Escape") onEditCancel();
              }}
            />
          ) : (
            <div
              className={cn(
                "truncate text-[14.5px] font-semibold leading-[1.45]",
                isUnread ? "text-foreground" : isReadCompleted ? "text-muted-foreground" : "text-foreground/90",
              )}
            >
              {displayText}
            </div>
          )}
          {previewText && (
            <div className="mt-1 line-clamp-2 text-sm leading-[1.55] text-muted-foreground">
              {previewText}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold leading-none", config.chipClass)}>
            <span
              className={cn(
                "mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-[1px]",
                config.dotClass,
                config.animate && "animate-[lg-pulse_1.6s_infinite]",
              )}
            />
            {config.label}
          </span>
          <span className="font-mono text-xs text-muted-foreground/70">{timeStr}</span>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 items-center gap-1">
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
        <div className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <SessionPortrait url={session.agentPortraitUrl} name={session.agentName} />
          <span className="max-w-28 truncate">{session.agentName ?? session.agentId ?? "Agent"}</span>
        </div>
      </div>
    </LiquidGlassCard>
  );
});
