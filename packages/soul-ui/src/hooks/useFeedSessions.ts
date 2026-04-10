/**
 * useFeedSessions / useFeedUnreadCount
 *
 * 피드 뷰에서 사용하는 세션 목록과 미읽음 카운트 훅.
 *
 * Phase 3: Zustand sessions + catalog 구독 방식으로 구현.
 * - sessions 동기화 effect(useSessionListProvider.ts)가 Phase 5까지 유지되므로 반응성 보장.
 * - queryClient.getQueriesData()는 스냅샷만 반환하고 React 구독이 없으므로 사용 금지.
 *
 * Phase 5에서 sessions 상태가 제거될 때 queryCache.subscribe() 패턴으로 교체된다.
 */

import type { SessionSummary } from "../shared/types";
import { useDashboardStore, isSessionUnread } from "../stores/dashboard-store";
import { filterFeedSessions } from "./session-stream-helpers";

/**
 * 피드 세션 목록 훅.
 * - llm 세션 제외, excludeFromFeed 폴더 제외, 24시간 이내 활동 세션만 반환.
 */
export function useFeedSessions(): SessionSummary[] {
  const sessions = useDashboardStore((s) => s.sessions);
  const catalog = useDashboardStore((s) => s.catalog);
  return filterFeedSessions(sessions, catalog);
}

/**
 * 피드 미읽음 카운트 훅.
 * useFeedSessions와 동일한 필터 기준으로 미읽음 세션 수를 반환한다.
 */
export function useFeedUnreadCount(): number {
  const feedSessions = useFeedSessions();
  return feedSessions.filter(isSessionUnread).length;
}
