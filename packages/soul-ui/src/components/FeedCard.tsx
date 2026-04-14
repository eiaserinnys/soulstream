/**
 * FeedCard - 피드 뷰 세션 카드
 *
 * 고정 높이 카드. 3단 구조: 제목 / 메타 정보 / 메시지 미리보기.
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
import { MarkdownContent } from "./MarkdownContent";
import { ProfileAvatar } from "./ProfileAvatar";
import { cn } from "../lib/cn";

const DEFAULT_PROFILE = {
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

  // --- 제목 ---
  const title = session.displayName
    ? `📌 ${session.displayName}`
    : session.lastMessage?.preview
      ? `🗨️ ${session.lastMessage.preview}`
      : session.prompt || session.agentSessionId;

  // --- 시간 ---
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
        "h-[220px] rounded-lg border relative p-4 cursor-pointer transition-colors overflow-hidden flex flex-col gap-2",
        isDragging && "opacity-50",
        isRunning
          ? [
              // 배경과 테두리는 animation keyframe(box-shadow)에서 처리
              // unread: 왼쪽 테두리만 초록으로 유지, 나머지는 너비 0으로 제거
              isUnread
                ? "border-t-0 border-r-0 border-b-0 border-l-[3px] border-l-success"
                : "border-transparent",
              // running variant CSS class (::before shimmer + background animation)
              isActive ? "card-running-base card-running-active"
                : isUnread ? "card-running-base card-running-unread"
                : "card-running-base card-running",
            ]
          : isUnread
            ? [
                "border-l-[3px] border-t border-r border-b border-border",
                isError
                  ? "border-l-accent-red bg-accent-red/[0.06]"
                  : "border-l-info bg-info/[0.04]",
              ]
            : [
                "border-border",
                isActive && (
                  isError
                    ? "ring-[1.5px] ring-accent-red/80 bg-accent-red/[0.06]"
                    : "ring-1 ring-accent-blue bg-accent-blue/[0.06]"
                ),
                !isActive && isError && "bg-accent-red/[0.06]",
              ],
        !isActive && !isRunning && "hover:bg-accent/30",
      )}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      data-session-id={session.agentSessionId}
    >
      {/* 제목 */}
      <div className={cn(
        "text-base font-semibold truncate",
        isUnread ? "text-foreground" : "text-foreground/80",
      )}>
        {title}
      </div>

      {/* 메타 정보 */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
        {folderName && (
          <>
            <span className="truncate max-w-[100px]">{folderName}</span>
            <span>·</span>
          </>
        )}
        {session.agentName && (
          <>
            <span className="truncate max-w-[100px] opacity-70">{session.agentName}</span>
            <span>·</span>
          </>
        )}
        {timeStr && <span>{timeStr}</span>}
        {session.nodeId && (
          <>
            <span>·</span>
            <NodeBadge nodeId={session.nodeId} />
          </>
        )}
        <span>·</span>
        <span className="flex items-center gap-1">
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full inline-block",
              statusConfig.dotClass,
              statusConfig.animate && "animate-[pulse_2s_infinite]",
            )}
          />
          {session.status}
        </span>
      </div>

      {/* 메시지 미리보기 */}
      <div className="flex-1 overflow-hidden flex flex-col gap-1.5 text-sm">
        {session.prompt && (
          <div className="flex items-start gap-1.5 overflow-hidden">
            <ProfileAvatar
              role="user"
              hasPortrait={session.userPortraitUrl ? true : profileConfig.user.hasPortrait}
              portraitUrl={session.userPortraitUrl ?? undefined}
              fallbackEmoji="👤"
            />
            <div className="flex-1 min-w-0 overflow-hidden">
              <span className="text-xs font-medium shrink-0">{session.userName ?? profileConfig.user.name}</span>
              <span className="text-muted-foreground text-xs mx-1 shrink-0">|</span>
              <div className="text-foreground/70 overflow-hidden mt-0.5 line-clamp-2">
                <MarkdownContent content={session.prompt} compact />
              </div>
            </div>
          </div>
        )}
        {session.lastMessage?.preview && session.lastMessage.preview !== session.prompt && (() => {
          const isUser = session.lastMessage.type === "user";
          return (
            <div className="flex items-start gap-1.5 overflow-hidden">
              <ProfileAvatar
                role={isUser ? "user" : "assistant"}
                hasPortrait={isUser ? (session.userPortraitUrl ? true : profileConfig.user.hasPortrait) : !!session.agentPortraitUrl}
                fallbackEmoji={isUser ? "👤" : "🤖"}
                portraitUrl={isUser ? (session.userPortraitUrl ?? undefined) : session.agentPortraitUrl}
              />
              <div className="flex-1 min-w-0 overflow-hidden">
                <span className="text-xs font-medium shrink-0">
                  {isUser ? (session.userName ?? profileConfig.user.name) : (session.agentName ?? "Assistant")}
                </span>
                <span className="text-muted-foreground text-xs mx-1 shrink-0">|</span>
                <div className="text-foreground/70 overflow-hidden mt-0.5 line-clamp-2">
                  <MarkdownContent content={session.lastMessage.preview} compact />
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
});
