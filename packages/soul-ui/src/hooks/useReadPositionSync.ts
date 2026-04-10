/**
 * useReadPositionSync - 읽음 상태 동기화 훅
 *
 * 활성 세션의 읽음 위치를 서버와 동기화한다.
 * - 세션 선택 시: 즉시 읽음 처리
 * - 활성 세션의 lastEventId 변경 시: debounce 후 읽음 처리
 */

import { useDashboardStore } from "../stores/dashboard-store";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useRef, useEffect, useCallback } from "react";
import { applySessionUpdated, type SessionPage } from "./session-stream-helpers";

const DEBOUNCE_MS = 2000;

export function useReadPositionSync() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const activeSessionSummary = useDashboardStore((s) => s.activeSessionSummary);
  const setActiveSessionSummary = useDashboardStore((s) => s.setActiveSessionSummary);
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markAsRead = useCallback(
    async (sessionId: string, lastEventId: number) => {
      // TanStack Query 캐시 낙관적 업데이트
      queryClient.setQueriesData<InfiniteData<SessionPage>>(
        { queryKey: ["sessions"], exact: false },
        (old) => {
          if (!old) return old;
          return applySessionUpdated(old, sessionId, { lastReadEventId: lastEventId });
        },
      );
      // activeSessionSummary 낙관적 업데이트 (읽음 배지 즉시 제거)
      if (activeSessionSummary?.agentSessionId === sessionId) {
        setActiveSessionSummary({ ...activeSessionSummary, lastReadEventId: lastEventId });
      }
      try {
        await fetch(`/api/sessions/${sessionId}/read-position`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ last_read_event_id: lastEventId }),
        });
      } catch (e) {
        console.warn("Failed to update read position", e);
      }
    },
    [queryClient, activeSessionSummary, setActiveSessionSummary],
  );

  // 세션 선택 시 즉시 읽음 처리
  useEffect(() => {
    if (!activeSessionKey || !activeSessionSummary) return;
    if ((activeSessionSummary.lastEventId ?? 0) > (activeSessionSummary.lastReadEventId ?? 0)) {
      markAsRead(activeSessionKey, activeSessionSummary.lastEventId ?? 0);
    }
  }, [activeSessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 활성 세션의 lastEventId 변경 시 debounce로 읽음 처리
  const activeLastEventId = activeSessionSummary?.lastEventId ?? 0;
  const activeLastReadEventId = activeSessionSummary?.lastReadEventId ?? 0;

  useEffect(() => {
    if (!activeSessionKey || activeLastEventId === 0) return;
    if (activeLastEventId <= activeLastReadEventId) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      markAsRead(activeSessionKey, activeLastEventId);
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [activeSessionKey, activeLastEventId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { markAsRead };
}
