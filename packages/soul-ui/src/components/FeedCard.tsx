/**
 * FeedCard - 피드 뷰 세션 카드
 *
 * 고정 높이 카드. 3단 구조: 제목 / 메타 정보 / 메시지 미리보기.
 * FolderContents의 SessionItem과 동일한 스타일 토큰을 재사용한다.
 */

import { memo } from "react";
import type { SessionSummary } from "../shared/types";
import { isSessionUnread } from "../stores/dashboard-store";
import { STATUS_CONFIG, nodeIdToHue } from "./FolderContents";
import { MarkdownContent } from "./MarkdownContent";
import { cn } from "../lib/cn";
import { Badge } from "./ui/badge";
import { useTheme } from "../hooks/useTheme";

export interface FeedCardProps {
  session: SessionSummary;
  isActive: boolean;
  folderName?: string;
  onClick: () => void;
  onDoubleClick: () => void;
}

export const FeedCard = memo(function FeedCard({
  session,
  isActive,
  folderName,
  onClick,
  onDoubleClick,
}: FeedCardProps) {
  const config = STATUS_CONFIG[session.status] ?? STATUS_CONFIG.unknown;
  const isUnread = isSessionUnread(session);
  const [theme] = useTheme();

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

  // --- 노드 뱃지 스타일 ---
  const nodeBadge = session.nodeId ? (() => {
    const hue = nodeIdToHue(session.nodeId);
    const isDark = theme === "dark";
    return {
      bg: isDark ? `hsl(${hue}, 12%, 28%)` : `hsl(${hue}, 20%, 88%)`,
      color: isDark ? `hsl(${hue}, 18%, 72%)` : `hsl(${hue}, 30%, 35%)`,
      label: session.nodeId,
    };
  })() : null;

  return (
    <div
      className={cn(
        "h-[220px] rounded-lg border p-4 cursor-pointer transition-colors overflow-hidden flex flex-col gap-2",
        isUnread
          ? "border-l-[3px] border-l-info bg-info/[0.04] border-t border-r border-b border-border"
          : "border-border",
        isActive && "ring-1 ring-accent-blue bg-accent-blue/[0.06]",
        !isActive && "hover:bg-accent/30",
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
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
        {timeStr && <span>{timeStr}</span>}
        {nodeBadge && (
          <>
            <span>·</span>
            <Badge
              variant="secondary"
              className="text-[10px] px-1 py-0"
              style={{ backgroundColor: nodeBadge.bg, color: nodeBadge.color }}
            >
              {nodeBadge.label}
            </Badge>
          </>
        )}
        <span>·</span>
        <span className="flex items-center gap-1">
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full inline-block",
              config.dotClass,
              config.animate && "animate-[pulse_2s_infinite]",
            )}
          />
          {session.status}
        </span>
      </div>

      {/* 메시지 미리보기 */}
      <div className="flex-1 overflow-hidden flex flex-col gap-1.5 text-sm">
        {session.prompt && (
          <div className="overflow-hidden">
            <span className="text-muted-foreground font-medium">User</span>
            <div className="text-foreground/70 overflow-hidden mt-0.5">
              <MarkdownContent content={session.prompt} compact />
            </div>
          </div>
        )}
        {session.lastMessage?.preview && session.lastMessage.preview !== session.prompt && (
          <div className="overflow-hidden">
            <span className="text-muted-foreground font-medium">
              {session.lastMessage.type === "user" ? "User" : "Assistant"}
            </span>
            <div className="text-foreground/70 overflow-hidden mt-0.5">
              <MarkdownContent content={session.lastMessage.preview} compact />
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
