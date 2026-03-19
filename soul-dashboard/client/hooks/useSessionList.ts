/**
 * useSessionList - 세션 목록 SSE 구독 훅
 *
 * /api/sessions/stream SSE를 구독하여 세션 목록을 실시간 갱신합니다.
 * 폴링 대신 서버에서 푸시하는 이벤트를 수신합니다.
 */

import { useEffect, useRef, useCallback } from "react";
import { useDashboardStore, type SessionStreamEvent, type SessionStatus } from "@seosoyoung/soul-ui";

interface UseSessionListOptions {
  /** SSE 구독 활성화. 기본 true */
  enabled?: boolean;
  /** 재연결 시도 전 대기 시간 (ms). 기본 3000 */
  reconnectDelayMs?: number;
  /** 최대 재연결 시도 횟수. 기본 5 */
  maxReconnectAttempts?: number;
}

/**
 * SSE 연결 상태
 */
export type SSEConnectionState = "connecting" | "connected" | "disconnected" | "error";

export function useSessionList(options: UseSessionListOptions = {}) {
  const {
    enabled = true,
    reconnectDelayMs = 3000,
    maxReconnectAttempts = 5,
  } = options;

  const setSessions = useDashboardStore((s) => s.setSessions);
  const addSession = useDashboardStore((s) => s.addSession);
  const updateSession = useDashboardStore((s) => s.updateSession);
  const removeSession = useDashboardStore((s) => s.removeSession);
  const setSessionsLoading = useDashboardStore((s) => s.setSessionsLoading);
  const setSessionsError = useDashboardStore((s) => s.setSessionsError);

  const sessions = useDashboardStore((s) => s.sessions);
  const loading = useDashboardStore((s) => s.sessionsLoading);
  const error = useDashboardStore((s) => s.sessionsError);

  // 연결 상태 추적
  const connectionStateRef = useRef<SSEConnectionState>("disconnected");
  const reconnectAttemptsRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * SSE 이벤트 처리
   */
  const handleSSEEvent = useCallback(
    (event: SessionStreamEvent) => {
      switch (event.type) {
        case "session_list":
          // 초기 목록 설정
          setSessions(event.sessions, event.total);
          setSessionsLoading(false);
          break;

        case "session_created":
          // 새 세션 추가 (목록 앞에)
          addSession(event.session);
          break;

        case "session_updated":
          // 기존 세션 상태 업데이트
          updateSession(event.agent_session_id, {
            status: event.status as SessionStatus,
            updatedAt: event.updated_at,
          });
          break;

        case "session_deleted":
          // 목록에서 제거
          removeSession(event.agent_session_id);
          break;
      }
    },
    [setSessions, addSession, updateSession, removeSession, setSessionsLoading]
  );

  /**
   * SSE 연결 설정
   */
  const connect = useCallback(() => {
    // 이미 연결 중이면 무시
    if (eventSourceRef.current) {
      return;
    }

    connectionStateRef.current = "connecting";
    setSessionsLoading(true);

    const eventSource = new EventSource("/api/sessions/stream");
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      connectionStateRef.current = "connected";
      reconnectAttemptsRef.current = 0;
      setSessionsError(null);
    };

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as SessionStreamEvent;
        handleSSEEvent(data);
      } catch (err) {
        console.error("[useSessionList] Failed to parse SSE event:", err);
      }
    };

    eventSource.onerror = () => {
      connectionStateRef.current = "error";
      eventSource.close();
      eventSourceRef.current = null;

      // 재연결 시도
      if (reconnectAttemptsRef.current < maxReconnectAttempts) {
        reconnectAttemptsRef.current++;
        setSessionsError(
          `연결이 끊어졌습니다. 재연결 시도 중... (${reconnectAttemptsRef.current}/${maxReconnectAttempts})`
        );

        reconnectTimeoutRef.current = setTimeout(() => {
          if (enabled) {
            connect();
          }
        }, reconnectDelayMs);
      } else {
        setSessionsError("세션 목록 연결 실패. 페이지를 새로고침해주세요.");
        setSessionsLoading(false);
      }
    };
  }, [
    enabled,
    reconnectDelayMs,
    maxReconnectAttempts,
    handleSSEEvent,
    setSessionsLoading,
    setSessionsError,
  ]);

  /**
   * SSE 연결 해제
   */
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    connectionStateRef.current = "disconnected";
  }, []);

  /**
   * 수동 재연결 (에러 복구용)
   */
  const reconnect = useCallback(() => {
    disconnect();
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect, disconnect]);

  // 마운트 시 연결, 언마운트 시 해제
  useEffect(() => {
    if (!enabled) {
      disconnect();
      return;
    }

    connect();

    return () => {
      disconnect();
    };
  }, [enabled, connect, disconnect]);

  return {
    sessions,
    loading,
    error,
    /** SSE 연결 상태 */
    connectionState: connectionStateRef.current,
    /** 수동 재연결 */
    reconnect,
  };
}
