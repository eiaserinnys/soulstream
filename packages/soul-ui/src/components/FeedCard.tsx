/**
 * FeedCard - 피드 뷰 세션 카드
 *
 * 고정 높이 피드 행. 액터 / 세션 제목 / 폴더 칩 / 최신 메시지 미리보기를 표시한다.
 * FolderContents의 SessionItem과 동일한 스타일 토큰을 재사용한다.
 */

import { memo, useCallback } from "react";
import type React from "react";
import { useDraggable } from "@dnd-kit/core";
import type { SessionSummary } from "../shared/types";
import type { DashboardConfig } from "../stores/dashboard-store";
import { isSessionUnread } from "../stores/dashboard-store";
import { STATUS_CONFIG } from "./FolderContents";
import { NodeBadge } from "./NodeBadge";
import { BackendBadge } from "./BackendBadge";
import { ProfileAvatar } from "./ProfileAvatar";
import { cn } from "../lib/cn";

const DEFAULT_PROFILE: DashboardConfig = {
  user: { name: "User", id: "", hasPortrait: false },
  agents: [] as { id: string; name: string; hasPortrait: boolean; portraitUrl: string | null }[],
};

export interface FeedCardProps {
  session: SessionSummary;
  isActive: boolean;
  folderName?: string;
  dashboardConfig?: DashboardConfig | null;
  onCardClick: (sessionId: string) => void;
  onCardDoubleClick: (sessionId: string) => void;
  onCardContextMenu?: (sessionId: string, e: React.MouseEvent) => void;
}

export const FeedCard = memo(function FeedCard({
  session,
  isActive,
  folderName,
  dashboardConfig,
  onCardClick,
  onCardDoubleClick,
  onCardContextMenu,
}: FeedCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: session.agentSessionId,
    data: { type: "session", sessionIds: [session.agentSessionId] },
  });

  const statusConfig = STATUS_CONFIG[session.status] ?? STATUS_CONFIG.unknown;
  const isRunning = session.status === 'running';
  const isError = session.status === 'error';
  const isUnread = isSessionUnread(session);
  // dashboardConfig가 {}처럼 user 필드 없는 객체일 때도 DEFAULT_PROFILE로 fallback
  const profileConfig = (dashboardConfig?.user != null ? dashboardConfig : null) ?? DEFAULT_PROFILE;
  const userPortraitUrl =
    session.userPortraitUrl ?? profileConfig.user.portraitUrl ?? undefined;
  const actorIsUser = session.lastMessage?.type === "user";
  const actorName = actorIsUser
    ? (session.userName ?? profileConfig.user.name)
    : (session.agentName ?? "Assistant");
  const actorPortraitUrl = actorIsUser ? userPortraitUrl : session.agentPortraitUrl;

  const handleClick = useCallback(
    () => onCardClick(session.agentSessionId),
    [onCardClick, session.agentSessionId],
  );
  const handleDoubleClick = useCallback(
    () => onCardDoubleClick(session.agentSessionId),
    [onCardDoubleClick, session.agentSessionId],
  );
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => onCardContextMenu?.(session.agentSessionId, e),
    [onCardContextMenu, session.agentSessionId],
  );

  const title = session.displayName
    ? session.displayName
    : session.lastMessage?.preview
      ? session.lastMessage.preview
      : session.prompt || session.agentSessionId;
  const preview = session.lastMessage?.preview ?? session.prompt ?? "";

  const displayTime = session.lastMessage?.timestamp ?? session.updatedAt ?? session.createdAt;
  const timeStr = displayTime
    ? new Date(displayTime).toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "relative flex h-full cursor-pointer items-start gap-3 overflow-hidden rounded-[18px] border border-white/8 bg-[var(--lg-card)] px-4 py-3 text-[13px] shadow-[0_8px_26px_-18px_rgb(20_26_40_/_45%)] transition-[border-color,box-shadow,opacity] duration-200 ease-out",
        isDragging && "opacity-50",
        isActive && "border-accent-blue/55 ring-1 ring-accent-blue/50",
        isUnread && !isActive && "border-l-[3px] border-l-info",
        isRunning && "card-running-base",
        isError && !isActive && "border-l-[3px] border-l-accent-red",
        !isActive && "hover:border-accent-blue/35 hover:shadow-[0_12px_32px_-18px_rgb(10_30_70_/_50%)]",
      )}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      data-session-id={session.agentSessionId}
    >
      <ProfileAvatar
        role={actorIsUser ? "user" : "assistant"}
        hasPortrait={!!actorPortraitUrl}
        fallbackEmoji={actorIsUser ? "👤" : "🤖"}
        portraitUrl={actorPortraitUrl}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className={cn(
            "min-w-0 flex-1 truncate font-semibold leading-[1.5]",
            isUnread ? "text-foreground" : "text-foreground/90",
          )}>
            {title}
          </div>
          {folderName && (
            <span className="max-w-28 shrink-0 truncate rounded-full bg-muted px-2.5 py-0.5 text-[10.5px] text-muted-foreground">
              {folderName}
            </span>
          )}
          {timeStr && (
            <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
              {timeStr}
            </span>
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className="truncate">{actorName}</span>
          <span className="opacity-50">·</span>
          <span className="flex shrink-0 items-center gap-1">
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                statusConfig.dotClass,
                statusConfig.animate && "animate-[lg-pulse_1.6s_infinite]",
              )}
            />
            {statusConfig.label}
          </span>
          {session.backend && <BackendBadge backend={session.backend} />}
          {session.nodeId && <NodeBadge nodeId={session.nodeId} />}
        </div>
        {preview && (
          <div className="mt-1 line-clamp-1 text-[12px] leading-[1.5] text-muted-foreground">
            {preview}
          </div>
        )}
      </div>
    </div>
  );
});
