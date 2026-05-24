/**
 * useFeedSessions / useFeedUnreadCount
 *
 * 피드 뷰에서 사용하는 세션 목록과 미읽음 카운트 훅.
 *
 * - TanStack Query 캐시에서 현재 feed query page만 읽어 filterFeedSessions로 필터링한다.
 * - 현재 feed query 변경 시에만 cacheVersion을 증가시켜 useMemo를 재계산한다.
 */

import { useState, useEffect, useMemo } from "react";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { SessionSummary } from "../shared/types";
import { useDashboardStore, isSessionUnread } from "../stores/dashboard-store";
import { filterFeedSessions, type SessionPage } from "./session-stream-helpers";

function isCurrentFeedQueryKey(
  queryKey: readonly unknown[],
  sessionTypeFilter: string,
): boolean {
  return (
    queryKey[0] === "sessions" &&
    queryKey[1] === sessionTypeFilter &&
    queryKey[2] === "feed" &&
    queryKey[3] === null
  );
}

/**
 * 피드 세션 목록 훅.
 * - llm 세션 제외, excludeFromFeed 폴더 제외, updatedAt DESC 정렬.
 */
export function useFeedSessions(): SessionSummary[] {
  const queryClient = useQueryClient();
  const catalog = useDashboardStore((s) => s.catalog);
  const sessionTypeFilter = useDashboardStore((s) => s.sessionTypeFilter);
  const [cacheVersion, setCacheVersion] = useState(0);

  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (!isCurrentFeedQueryKey(event.query.queryKey, sessionTypeFilter)) return;
      setCacheVersion((v) => v + 1);
    });
    return unsubscribe;
  }, [queryClient, sessionTypeFilter]);

  return useMemo(() => {
    const data = queryClient.getQueryData<InfiniteData<SessionPage>>([
      "sessions",
      sessionTypeFilter,
      "feed",
      null,
    ]);
    const feedSessions = data?.pages.flatMap((page) => page.sessions) ?? [];
    return filterFeedSessions(feedSessions, catalog);
  }, [cacheVersion, catalog, queryClient, sessionTypeFilter]);
}

/**
 * 피드 미읽음 카운트 훅.
 * useFeedSessions와 동일한 필터 기준으로 미읽음 세션 수를 반환한다.
 */
export function useFeedUnreadCount(): number {
  const feedSessions = useFeedSessions();
  return feedSessions.filter(isSessionUnread).length;
}
