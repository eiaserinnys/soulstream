/**
 * useFeedSessions / useFeedUnreadCount
 *
 * 피드 뷰에서 사용하는 세션 목록과 미읽음 카운트 훅.
 *
 * Phase 5: queryCache.subscribe() 패턴으로 전환.
 * - TanStack Query 캐시에서 전체 세션을 읽어 filterFeedSessions로 필터링한다.
 * - queryCache 변경 시 cacheVersion을 증가시켜 useMemo를 재계산한다.
 */

import { useState, useEffect, useMemo } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { SessionSummary } from "../shared/types";
import { useDashboardStore, isSessionUnread } from "../stores/dashboard-store";
import { filterFeedSessions, type SessionPage } from "./session-stream-helpers";

/**
 * 피드 세션 목록 훅.
 * - llm 세션 제외, excludeFromFeed 폴더 제외, 24시간 이내 활동 세션만 반환.
 */
export function useFeedSessions(): SessionSummary[] {
  const queryClient = useQueryClient();
  const catalog = useDashboardStore((s) => s.catalog);
  const [cacheVersion, setCacheVersion] = useState(0);

  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      setCacheVersion((v) => v + 1);
    });
    return unsubscribe;
  }, [queryClient]);

  return useMemo(() => {
    const allData = queryClient.getQueriesData<InfiniteData<SessionPage>>({
      queryKey: ["sessions"],
      exact: false,
    });
    const allSessions: SessionSummary[] = [];
    for (const [, data] of allData) {
      if (!data) continue;
      for (const page of data.pages) allSessions.push(...page.sessions);
    }
    // agentSessionId 기준 중복 제거 — 피드/폴더/리스트 등 여러 뷰 캐시가 동시에 존재할 때
    // exact: false로 수집된 같은 세션이 중복 포함되는 것을 방지
    const uniqueSessions = Array.from(
      new Map(allSessions.map((s) => [s.agentSessionId, s])).values(),
    );
    return filterFeedSessions(uniqueSessions, catalog);
  }, [cacheVersion, catalog, queryClient]);
}

/**
 * 피드 미읽음 카운트 훅.
 * useFeedSessions와 동일한 필터 기준으로 미읽음 세션 수를 반환한다.
 */
export function useFeedUnreadCount(): number {
  const feedSessions = useFeedSessions();
  return feedSessions.filter(isSessionUnread).length;
}
