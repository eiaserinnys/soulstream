/**
 * useSessionListProvider - Provider 기반 세션 목록 훅
 *
 * 현재 스토리지 모드에 따라 적절한 방식으로 세션 목록을 조회합니다:
 * - file 모드: SSE 구독 (실시간 업데이트)
 * - serendipity 모드: 폴링 (5초 간격)
 */

import { useEffect, useRef, useCallback } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { getSessionProvider } from "../providers";
import type { SessionStreamEvent, SessionStatus } from "@shared/types";

interface UseSessionListProviderOptions {
  /** 폴링 간격 (ms). serendipity 모드에서만 사용. 기본 5000 */
  intervalMs?: number;
  /** 자동 조회/구독 활성화. 기본 true */
  enabled?: boolean;
}

export function useSessionListProvider(
  options: UseSessionListProviderOptions = {}
) {
  const { intervalMs = 5000, enabled = true } = options;

  const storageMode = useDashboardStore((s) => s.storageMode);
  const setSessions = useDashboardStore((s) => s.setSessions);
  const addSession = useDashboardStore((s) => s.addSession);
  const updateSession = useDashboardStore((s) => s.updateSession);
  const removeSession = useDashboardStore((s) => s.removeSession);
  const setSessionsLoading = useDashboardStore((s) => s.setSessionsLoading);
  const setSessionsError = useDashboardStore((s) => s.setSessionsError);

  const sessions = useDashboardStore((s) => s.sessions);
  const loading = useDashboardStore((s) => s.sessionsLoading);
  const error = useDashboardStore((s) => s.sessionsError);

  // 첫 로드 추적 (초기엔 로딩 표시, 이후엔 백그라운드 갱신)
  const isFirstLoad = useRef(true);
  const abortRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  /**
   * SSE 이벤트 처리 (file 모드)
   */
  const handleSSEEvent = useCallback(
    (event: SessionStreamEvent) => {
      switch (event.type) {
        case "session_list":
          setSessions(event.sessions);
          setSessionsLoading(false);
          break;

        case "session_created":
          addSession(event.session);
          break;

        case "session_updated":
          updateSession(event.agent_session_id, {
            status: event.status as SessionStatus,
            completedAt: event.updated_at,
          });
          break;

        case "session_deleted":
          removeSession(event.agent_session_id);
          break;
      }
    },
    [setSessions, addSession, updateSession, removeSession, setSessionsLoading]
  );

  /**
   * SSE 연결 설정 (file 모드)
   */
  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) return;

    setSessionsLoading(true);

    const eventSource = new EventSource("/api/sessions/stream");
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setSessionsError(null);
    };

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as SessionStreamEvent;
        handleSSEEvent(data);
      } catch (err) {
        console.error("[useSessionListProvider] Failed to parse SSE event:", err);
      }
    };

    eventSource.onerror = () => {
      setSessionsError("세션 목록 연결이 끊어졌습니다. 자동 재연결 중...");
      // EventSource 기본 동작: 자동 재연결
    };
  }, [handleSSEEvent, setSessionsLoading, setSessionsError]);

  /**
   * SSE 연결 해제
   */
  const disconnectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  /**
   * 폴링으로 세션 목록 조회 (serendipity 모드)
   */
  const fetchSessions = useCallback(async () => {
    // 첫 로드에만 로딩 표시
    if (isFirstLoad.current) {
      setSessionsLoading(true);
    }

    try {
      abortRef.current = false;

      const provider = getSessionProvider(storageMode);
      const data = await provider.fetchSessions();

      if (abortRef.current) return; // 취소된 요청은 무시

      setSessions(data);
    } catch (err: unknown) {
      if (abortRef.current) return;

      const message =
        err instanceof Error ? err.message : "세션 목록 조회 실패";
      setSessionsError(message);
    } finally {
      // 항상 첫 로드 완료 표시 (에러 시에도 로딩 플리커 방지)
      isFirstLoad.current = false;
      setSessionsLoading(false);
    }
  }, [storageMode, setSessions, setSessionsLoading, setSessionsError]);

  // 모드에 따라 SSE 구독 또는 폴링
  useEffect(() => {
    if (!enabled) return;

    // 모드 변경 시 첫 로드 플래그 리셋
    isFirstLoad.current = true;

    if (storageMode === "file") {
      // file 모드: SSE 구독
      connectSSE();

      return () => {
        disconnectSSE();
      };
    } else {
      // serendipity 모드: 폴링
      fetchSessions();

      const timer = setInterval(fetchSessions, intervalMs);

      return () => {
        clearInterval(timer);
        abortRef.current = true;
      };
    }
  }, [enabled, storageMode, connectSSE, disconnectSSE, fetchSessions, intervalMs]);

  return {
    sessions,
    loading,
    error,
    /** 수동 새로고침 (serendipity 모드에서 사용) */
    refetch: storageMode === "serendipity" ? fetchSessions : undefined,
    storageMode,
  };
}
