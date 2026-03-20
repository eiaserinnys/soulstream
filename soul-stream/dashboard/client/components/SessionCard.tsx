/**
 * SessionCard — 세션 카드. 세션 ID, 상태 표시.
 */

import { Badge, cn } from "@seosoyoung/soul-ui";
import type { OrchestratorSession } from "../store/types";

interface StatusConfig {
  label: string;
  badgeVariant: "success" | "warning" | "outline" | "error";
  dotClass: string;
  animate: boolean;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  running:   { label: "Running",   badgeVariant: "success", dotClass: "bg-success",          animate: true },
  idle:      { label: "Idle",      badgeVariant: "warning", dotClass: "bg-accent-amber",     animate: false },
  completed: { label: "Done",      badgeVariant: "outline", dotClass: "bg-muted-foreground", animate: false },
  error:     { label: "Error",     badgeVariant: "error",   dotClass: "bg-accent-red",       animate: false },
};

interface SessionCardProps {
  session: OrchestratorSession;
  isSelected: boolean;
  isActive: boolean;
  onClick: () => void;
}

export function SessionCard({
  session,
  isSelected,
  isActive,
  onClick,
}: SessionCardProps) {
  const config = STATUS_CONFIG[session.status] ?? STATUS_CONFIG.completed;

  // 제목 계산: lastMessage.preview → prompt → sessionId
  const raw = session.lastMessage?.preview ?? session.prompt ?? session.sessionId;
  const title = raw.length > 30 ? raw.slice(0, 27) + "..." : raw;

  // 시간 계산: lastMessage.timestamp → updatedAt → createdAt
  const tsRaw = session.lastMessage?.timestamp ?? session.updatedAt ?? session.createdAt;
  const timeStr = tsRaw
    ? new Date(tsRaw).toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  return (
    <div
      className={cn(
        "bg-card border rounded-[10px] px-3 py-2.5 cursor-pointer transition-colors shrink-0 border-l-[3px] hover:bg-muted",
        isSelected
          ? "border-l-accent-blue bg-accent-blue/[0.06] border-accent-blue/15"
          : isActive
            ? "border-l-success border-border"
            : "border-l-transparent border-border",
      )}
      onClick={onClick}
    >
      {/* Top: title + status badge */}
      <div className="flex items-center justify-between mb-1">
        <span className="text-[13px] truncate font-medium text-foreground mr-2">
          {title}
        </span>
        <Badge variant={config.badgeVariant} size="sm">
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full",
              config.dotClass,
              config.animate && "animate-[pulse_2s_infinite]",
            )}
          />
          {config.label}
        </Badge>
      </div>

      {/* Bottom: time + nodeId */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground/50">
          {timeStr}
        </span>
        <span className="text-[11px] text-muted-foreground/50 font-mono">
          {session.nodeId}
        </span>
      </div>
    </div>
  );
}
