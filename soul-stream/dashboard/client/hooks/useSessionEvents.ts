/**
 * useSessionEvents — 세션 SSE 이벤트 스트림 훅.
 * sessionId가 바뀌면 이전 EventSource를 닫고 새로 구독한다.
 */

import { useEffect, useState } from "react";

export interface SessionEvent {
  type: string;
  session_id?: string;
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

export function useSessionEvents(sessionId: string | null): SessionEvent[] {
  const [events, setEvents] = useState<SessionEvent[]>([]);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      return;
    }

    setEvents([]);

    const es = new EventSource(`/api/sessions/${sessionId}/events`);

    es.onmessage = (e) => {
      try {
        const parsed: unknown = JSON.parse(e.data);
        if (parsed && typeof parsed === "object") {
          setEvents((prev) => [...prev, parsed as SessionEvent]);
        }
      } catch {
        // 파싱 실패 — 건너뜀
      }
    };

    es.onerror = () => {
      es.close();
    };

    return () => {
      es.close();
    };
  }, [sessionId]);

  return events;
}
