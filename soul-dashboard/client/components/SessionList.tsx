/**
 * SessionList + SessionItem - 세션 목록 컴포넌트
 *
 * 좌측 패널에 세션 목록을 표시합니다.
 * 각 세션의 상태를 인디케이터(점멸/뱃지)로 시각화합니다.
 * "+ New" 버튼으로 새 세션 생성을 제공합니다.
 */

import type { SessionSummary, SessionStatus } from "@shared/types";
import type { VariantProps } from "class-variance-authority";
import { useDashboardStore } from "../stores/dashboard-store";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { Badge, badgeVariants } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";

// === Status Badge Config ===

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

interface StatusConfig {
  label: string;
  badgeVariant: BadgeVariant;
  dotClass: string;
  animate: boolean;
}

const STATUS_CONFIG: Record<SessionStatus, StatusConfig> = {
  running: {
    label: "Running",
    badgeVariant: "success",
    dotClass: "bg-success",
    animate: true,
  },
  completed: {
    label: "Done",
    badgeVariant: "outline",
    dotClass: "bg-muted-foreground",
    animate: false,
  },
  error: {
    label: "Error",
    badgeVariant: "error",
    dotClass: "bg-accent-red",
    animate: false,
  },
  unknown: {
    label: "Unknown",
    badgeVariant: "secondary",
    dotClass: "bg-muted-foreground",
    animate: false,
  },
};

// === SessionItem ===

interface SessionItemProps {
  session: SessionSummary;
  isActive: boolean;
  onClick: () => void;
}

function SessionItem({ session, isActive, onClick }: SessionItemProps) {
  const config = STATUS_CONFIG[session.status];
  const sessionKey = `${session.clientId}:${session.requestId}`;

  // 시간 포맷
  const timeStr = session.createdAt
    ? new Date(session.createdAt).toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "...";

  return (
    <button
      data-testid={`session-item-${sessionKey}`}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 w-full py-2.5 px-3 border-none cursor-pointer text-left transition-colors duration-150 border-b border-b-border",
        isActive
          ? "border-l-[3px] border-l-accent-blue bg-accent-blue/8"
          : "border-l-[3px] border-l-transparent bg-transparent",
      )}
      title={sessionKey}
    >
      {/* Status indicator (점멸 애니메이션) */}
      <span
        className={cn(
          "w-2 h-2 rounded-full shrink-0",
          config.dotClass,
          config.animate && "animate-[pulse_2s_infinite]",
        )}
      />

      {/* Session info */}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-foreground truncate">
          {session.prompt
            ? session.prompt.length > 30
              ? session.prompt.slice(0, 27) + "..."
              : session.prompt
            : session.requestId.slice(0, 12)}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[11px] text-muted-foreground">
            {timeStr}
          </span>
          <Badge
            data-testid="session-status-badge"
            variant={config.badgeVariant}
            size="sm"
          >
            {config.label}
          </Badge>
        </div>
      </div>

      {/* Event count badge */}
      {session.eventCount > 0 && (
        <Badge variant="outline" size="sm" className="shrink-0">
          {session.eventCount}
        </Badge>
      )}
    </button>
  );
}

// === SessionList ===

interface SessionListProps {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
}

export function SessionList({ sessions, loading, error }: SessionListProps) {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const startCompose = useDashboardStore((s) => s.startCompose);
  const isComposing = useDashboardStore((s) => s.isComposing);

  const handleSelect = (session: SessionSummary) => {
    const key = `${session.clientId}:${session.requestId}`;
    setActiveSession(key);
  };

  return (
    <div
      data-testid="session-list"
      className="flex flex-col h-full overflow-hidden"
    >
      {/* Header + New button */}
      <div className="p-3 px-3.5 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-[0.05em] flex justify-between items-center">
        <span>Sessions</span>
        <Button
          data-testid="new-session-button"
          variant="outline"
          size="xs"
          onClick={startCompose}
          disabled={isComposing}
          title="New conversation"
          className="border-accent-blue/30 text-accent-blue hover:bg-accent-blue/10"
        >
          + New
        </Button>
      </div>

      {/* Loading state */}
      {loading && sessions.length === 0 && (
        <div className="p-5 text-center text-muted-foreground text-[13px]">
          Loading...
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="py-2.5 px-3.5 text-accent-red text-xs bg-accent-red/8">
          {error}
        </div>
      )}

      {/* Session list */}
      <ScrollArea className="flex-1">
        {sessions.length === 0 && !loading && (
          <div className="p-5 text-center text-muted-foreground text-[13px]">
            No sessions yet
          </div>
        )}
        {sessions.map((session) => {
          const key = `${session.clientId}:${session.requestId}`;
          return (
            <SessionItem
              key={key}
              session={session}
              isActive={activeSessionKey === key}
              onClick={() => handleSelect(session)}
            />
          );
        })}
      </ScrollArea>
    </div>
  );
}
