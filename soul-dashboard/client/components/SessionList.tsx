/**
 * SessionList + SessionItem - 세션 목록 컴포넌트
 *
 * 좌측 패널에 세션 목록을 표시합니다.
 * 세션 타입별 탭(All / Claude Code / LLM)과 페이지네이션을 제공합니다.
 * 각 세션의 상태를 인디케이터(점멸/뱃지)로 시각화합니다.
 * "+ New" 버튼으로 새 세션 생성을 제공합니다.
 */

import { memo, useMemo } from "react";
import type { SessionSummary, SessionStatus } from "@shared/types";
import type { VariantProps } from "class-variance-authority";
import { useDashboardStore } from "../stores/dashboard-store";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { Badge, badgeVariants } from "./ui/badge";
import { Tabs, TabsList, TabsTab } from "./ui/tabs";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "./ui/pagination";

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

// === SessionItem ===

interface SessionItemProps {
  session: SessionSummary;
  isActive: boolean;
  onClick: () => void;
}

const SessionItem = memo(function SessionItem({ session, isActive, onClick }: SessionItemProps) {
  const config = STATUS_CONFIG[session.status];
  const sessionKey = session.agentSessionId;

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
          {session.prompt
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
          {/* LLM 타입 인디케이터 */}
          {session.sessionType === "llm" && (
            <Badge
              variant="secondary"
              size="sm"
              className="text-[10px] px-1"
            >
              LLM
            </Badge>
          )}
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
});

// === Pagination Helpers ===

/**
 * 표시할 페이지 번호 목록을 계산합니다.
 * 현재 페이지 주변 2개씩, 첫/마지막 페이지, 중간에 Ellipsis를 포함합니다.
 */
function getPageNumbers(currentPage: number, totalPages: number): (number | "ellipsis")[] {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, i) => i);
  }

  const pages: (number | "ellipsis")[] = [];

  // 항상 첫 페이지
  pages.push(0);

  if (currentPage > 2) {
    pages.push("ellipsis");
  }

  // 현재 페이지 주변
  const start = Math.max(1, currentPage - 1);
  const end = Math.min(totalPages - 2, currentPage + 1);
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (currentPage < totalPages - 3) {
    pages.push("ellipsis");
  }

  // 항상 마지막 페이지
  pages.push(totalPages - 1);

  return pages;
}

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
  // 페이지네이션/필터 상태
  const sessionPage = useDashboardStore((s) => s.sessionPage);
  const sessionPageSize = useDashboardStore((s) => s.sessionPageSize);
  const sessionTypeFilter = useDashboardStore((s) => s.sessionTypeFilter);
  const setSessionPage = useDashboardStore((s) => s.setSessionPage);
  const setSessionTypeFilter = useDashboardStore((s) => s.setSessionTypeFilter);

  const totalPages = Math.ceil(sessionsTotal / sessionPageSize);

  const pageNumbers = useMemo(
    () => getPageNumbers(sessionPage, totalPages),
    [sessionPage, totalPages],
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
        {sessions.map((session) => (
            <SessionItem
              key={session.agentSessionId}
              session={session}
              isActive={activeSessionKey === session.agentSessionId}
              onClick={() => setActiveSession(session.agentSessionId)}
            />
          ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="border-t border-border py-1.5">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => setSessionPage(Math.max(0, sessionPage - 1))}
                  className={cn(
                    "h-7 text-xs cursor-pointer",
                    sessionPage === 0 && "pointer-events-none opacity-50",
                  )}
                />
              </PaginationItem>
              {pageNumbers.map((n, idx) =>
                n === "ellipsis" ? (
                  <PaginationItem key={`ellipsis-${idx}`}>
                    <PaginationEllipsis className="h-7" />
                  </PaginationItem>
                ) : (
                  <PaginationItem key={n}>
                    <PaginationLink
                      isActive={n === sessionPage}
                      onClick={() => setSessionPage(n)}
                      className="h-7 w-7 text-xs cursor-pointer"
                    >
                      {n + 1}
                    </PaginationLink>
                  </PaginationItem>
                ),
              )}
              <PaginationItem>
                <PaginationNext
                  onClick={() => setSessionPage(Math.min(totalPages - 1, sessionPage + 1))}
                  className={cn(
                    "h-7 text-xs cursor-pointer",
                    sessionPage >= totalPages - 1 && "pointer-events-none opacity-50",
                  )}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </div>
  );
}
