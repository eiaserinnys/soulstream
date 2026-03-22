/**
 * useReadPositionSync - 읽음 상태 동기화 훅
 *
 * 활성 세션의 읽음 위치를 서버와 동기화한다.
 * - 세션 선택 시: 즉시 읽음 처리
 * - 활성 세션의 lastEventId 변경 시: debounce 후 읽음 처리
 */

import { useDashboardStore } from "@seosoyoung/soul-ui";
import { useRef, useEffect, useCallback } from "react";

const DEBOUNCE_MS = 2000;

export function useReadPositionSync() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const sessions = useDashboardStore((s) => s.sessions);
  const updateSession = useDashboardStore((s) => s.updateSession);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markAsRead = useCallback(
    async (sessionId: string, lastEventId: number) => {
      updateSession(sessionId, { lastReadEventId: lastEventId });
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
    [updateSession],
  );

  // 세션 선택 시 즉시 읽음 처리
  useEffect(() => {
    if (!activeSessionKey) return;
    const session = sessions.find(
      (s) => s.agentSessionId === activeSessionKey,
    );
    if (session && (session.lastEventId ?? 0) > (session.lastReadEventId ?? 0)) {
      markAsRead(activeSessionKey, session.lastEventId ?? 0);
    }
  }, [activeSessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 활성 세션의 lastEventId 변경 시 debounce로 읽음 처리
  const activeSession = sessions.find(
    (s) => s.agentSessionId === activeSessionKey,
  );
  const activeLastEventId = activeSession?.lastEventId ?? 0;
  const activeLastReadEventId = activeSession?.lastReadEventId ?? 0;

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
