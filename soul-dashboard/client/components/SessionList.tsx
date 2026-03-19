/**
 * SessionList + SessionItem - 세션 목록 컴포넌트
 *
 * 좌측 패널에 세션 목록을 표시합니다.
 * 세션 타입별 탭(All / Claude Code / LLM)과 가상 스크롤을 제공합니다.
 * 각 세션의 상태를 인디케이터(점멸/뱃지)로 시각화합니다.
 * "+ New" 버튼으로 새 세션 생성을 제공합니다.
 */

import { memo, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { VariantProps } from "class-variance-authority";
import { LogOut } from "lucide-react";
import {
  type SessionSummary,
  type SessionStatus,
  useDashboardStore,
  cn,
  Button,
  Badge, badgeVariants,
  Tabs, TabsList, TabsTab,
} from "@seosoyoung/soul-ui";
import { useAuth } from "../providers/AuthProvider";

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
  interrupted: {
    label: "Interrupted",
    badgeVariant: "warning",
    dotClass: "bg-accent-amber",
    animate: false,
  },
  unknown: {
    label: "Unknown",
    badgeVariant: "secondary",
    dotClass: "bg-muted-foreground",
    animate: false,
  },
};

// === Helpers ===

function formatTokenCount(tokens: number): string {
  if (tokens >= 999_950) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

// === SessionItem ===

interface SessionItemProps {
  session: SessionSummary;
  isActive: boolean;
  onClick: () => void;
}

const SessionItem = memo(function SessionItem({ session, isActive, onClick }: SessionItemProps) {
  const config = STATUS_CONFIG[session.status];
  const sessionKey = session.agentSessionId;
  const isLlm = session.sessionType === "llm";

  // LLM 세션 라벨: "gpt-5-mini · translate" 형태
  const llmLabel = isLlm
    ? [session.llmModel, session.clientId].filter(Boolean).join(" \u00B7 ") || null
    : null;

  // LLM 토큰 배지
  const tokenBadge = isLlm && session.llmUsage
    ? `${formatTokenCount(session.llmUsage.inputTokens + session.llmUsage.outputTokens)} tok`
    : null;

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
        <div className="text-[15px] text-foreground truncate">
          {isLlm && (
            <span className="mr-1" title="LLM session">{"\u{1F916}"}</span>
          )}
          {isLlm && llmLabel
            ? llmLabel
            : session.prompt
              ? session.prompt.length > 30
                ? session.prompt.slice(0, 27) + "..."
                : session.prompt
              : session.agentSessionId.slice(0, 16)}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[12px] text-muted-foreground">
            {timeStr}
          </span>
          <Badge
            data-testid="session-status-badge"
            variant={config.badgeVariant}
            size="sm"
            className="text-[11px]"
          >
            {config.label}
          </Badge>
        </div>
      </div>

      {/* Token badge (LLM) or Event count badge (Claude) */}
      {isLlm && tokenBadge ? (
        <Badge variant="outline" size="sm" className="shrink-0" title="Token usage">
          {tokenBadge}
        </Badge>
      ) : session.eventCount > 0 ? (
        <Badge variant="outline" size="sm" className="shrink-0">
          {session.eventCount}
        </Badge>
      ) : null}
    </button>
  );
});

// === SessionList ===

interface SessionListProps {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
}

/** SessionItem의 예상 높이 (px) — 가상화 estimateSize에 사용 */
const ITEM_HEIGHT = 56;

export function SessionList({ sessions, loading, error }: SessionListProps) {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const sessionsTotal = useDashboardStore((s) => s.sessionsTotal);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const startCompose = useDashboardStore((s) => s.startCompose);
  const isComposing = useDashboardStore((s) => s.isComposing);
  const sessionTypeFilter = useDashboardStore((s) => s.sessionTypeFilter);
  const setSessionTypeFilter = useDashboardStore((s) => s.setSessionTypeFilter);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { authEnabled, user, logout } = useAuth();

  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 5,
  });

  const handleSelect = useCallback(
    (agentSessionId: string) => setActiveSession(agentSessionId),
    [setActiveSession],
  );

  const handleTabChange = (value: string | number | null) => {
    if (value === null) return;
    setSessionTypeFilter(String(value) as "all" | "claude" | "llm");
  };

  return (
    <div
      data-testid="session-list"
      className="flex flex-col h-full overflow-hidden"
    >
      {/* Header + New button */}
      <div className="p-3 px-3.5 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-[0.05em] flex justify-between items-center">
        <span>
          Sessions
          {sessionsTotal > 0 && (
            <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-muted-foreground/60">
              ({sessionsTotal})
            </span>
          )}
        </span>
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

      {/* Session type tabs */}
      <Tabs value={sessionTypeFilter} onValueChange={handleTabChange}>
        <TabsList variant="underline" className="w-full justify-start px-2 border-b border-border">
          <TabsTab value="all" className="text-xs h-7 px-2">All</TabsTab>
          <TabsTab value="claude" className="text-xs h-7 px-2">Claude Code</TabsTab>
          <TabsTab value="llm" className="text-xs h-7 px-2">LLM</TabsTab>
        </TabsList>
      </Tabs>

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

      {/* Session list — 가상 스크롤 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {sessions.length === 0 && !loading && (
          <div className="p-5 text-center text-muted-foreground text-[13px]">
            No sessions yet
          </div>
        )}
        {sessions.length > 0 && (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const session = sessions[virtualRow.index];
              return (
                <div
                  key={session.agentSessionId}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <SessionItem
                    session={session}
                    isActive={activeSessionKey === session.agentSessionId}
                    onClick={() => handleSelect(session.agentSessionId)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 사용자 정보 + 로그아웃 (authEnabled 시에만) */}
      {authEnabled && (
        <div className="shrink-0 border-t border-border px-3 py-2 flex items-center gap-2">
          {user?.picture ? (
            <img
              src={user.picture}
              alt={user.name}
              className="w-6 h-6 rounded-full shrink-0"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-accent-blue/20 flex items-center justify-center shrink-0">
              <span className="text-[10px] text-accent-blue font-semibold">
                {user?.name?.[0]?.toUpperCase() ?? "?"}
              </span>
            </div>
          )}
          <span className="flex-1 text-xs text-muted-foreground truncate min-w-0">
            {user?.name ?? user?.email ?? ""}
          </span>
          <button
            data-testid="logout-button"
            onClick={() => void logout()}
            title="로그아웃"
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors duration-150 p-0.5 rounded"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
