import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Radio } from "lucide-react";

import { Badge } from "../components/ui/badge";
import { SessionItem } from "../components/SessionItem";
import { applyCatalogDisplayNames } from "../hooks/session-catalog-helpers";
import type { SessionPage } from "../hooks/session-stream-helpers";
import { useIsMobile } from "../hooks/use-mobile";
import { type SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";

function sessionTimeValue(session: SessionSummary): number {
  const source = session.updatedAt ?? session.lastMessage?.timestamp ?? session.createdAt;
  return source ? new Date(source).getTime() : 0;
}

function collectSessionsFromCache(
  queryClient: ReturnType<typeof useQueryClient>,
): SessionSummary[] {
  const byId = new Map<string, SessionSummary>();
  for (const [, data] of queryClient.getQueriesData<InfiniteData<SessionPage>>({
    queryKey: ["sessions"],
    exact: false,
  })) {
    if (!data) continue;
    for (const page of data.pages) {
      for (const session of page.sessions) byId.set(session.agentSessionId, session);
    }
  }
  return Array.from(byId.values());
}

function useRunningSessions(): SessionSummary[] {
  const queryClient = useQueryClient();
  const catalog = useDashboardStore((s) => s.catalog);
  const catalogVersion = useDashboardStore((s) => s.catalogVersion);
  const [cacheVersion, setCacheVersion] = useState(0);

  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] !== "sessions") return;
      setCacheVersion((value) => value + 1);
    });
    return unsubscribe;
  }, [queryClient]);

  return useMemo(() => {
    const byId = new Map<string, SessionSummary>();
    for (const session of catalog?.sessionList ?? []) {
      byId.set(session.agentSessionId, session);
    }
    for (const session of collectSessionsFromCache(queryClient)) {
      byId.set(session.agentSessionId, session);
    }
    const sessions = applyCatalogDisplayNames(Array.from(byId.values()), catalog);
    return sessions
      .filter((session) => session.status === "running")
      .sort((left, right) => sessionTimeValue(right) - sessionTimeValue(left));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, catalogVersion, cacheVersion, queryClient]);
}

export function RunbookOverviewRunningSessions() {
  const runningSessions = useRunningSessions();
  const isMobile = useIsMobile();
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const selectedSessionIds = useDashboardStore((s) => s.selectedSessionIds);
  const setActiveSessionSummary = useDashboardStore((s) => s.setActiveSessionSummary);
  const toggleSessionSelection = useDashboardStore((s) => s.toggleSessionSelection);
  const setViewMode = useDashboardStore((s) => s.setViewMode);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);

  const handleSessionClick = (session: SessionSummary, event: MouseEvent) => {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
      setActiveSessionSummary(session);
    }
    toggleSessionSelection(
      session.agentSessionId,
      event.ctrlKey || event.metaKey,
      event.shiftKey,
      runningSessions,
    );
    setViewMode("runbooks");
    if (isMobile) setActiveTab("chat");
  };

  return (
    <section data-testid="runbook-overview-running-sessions" className="min-w-0">
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <Radio className="h-4 w-4 shrink-0 text-success" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">실행 중인 세션</h2>
        <Badge variant="success" size="sm" className="h-5 px-1.5 text-[10px]">
          {runningSessions.length}
        </Badge>
      </div>
      {runningSessions.length > 0 ? (
        <div
          data-testid="runbook-overview-running-sessions-rail"
          className="flex h-[7.75rem] min-w-0 snap-x snap-mandatory gap-2.5 overflow-x-auto overflow-y-hidden pb-2 [scrollbar-gutter:stable]"
        >
          {runningSessions.map((session) => (
            <div
              key={session.agentSessionId}
              className="h-full w-[15rem] max-w-[calc(100vw-4rem)] flex-none snap-start"
            >
              <SessionItem
                session={session}
                isActive={activeSessionKey === session.agentSessionId}
                isSelected={selectedSessionIds.has(session.agentSessionId)}
                isEditing={false}
                dragSessionIds={
                  selectedSessionIds.has(session.agentSessionId)
                    ? Array.from(selectedSessionIds)
                    : [session.agentSessionId]
                }
                onClick={(event) => handleSessionClick(session, event)}
                onContextMenu={(event) => event.preventDefault()}
                onEditSubmit={() => undefined}
                onEditCancel={() => undefined}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-[14px] border border-dashed border-success/30 px-3 py-4 text-center text-sm text-muted-foreground">
          실행 중인 세션 없음
        </div>
      )}
    </section>
  );
}
