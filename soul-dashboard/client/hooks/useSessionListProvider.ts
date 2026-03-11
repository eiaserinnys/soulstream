/**
 * useSessionListProvider - Provider 기반 세션 목록 훅
 *
 * 현재 스토리지 모드에 따라 적절한 방식으로 세션 목록을 조회합니다:
 * - sse 모드: fetchSessions API 호출 + SSE delta 이벤트 (session_created/updated/deleted)
 * - serendipity 모드: 폴링 (5초 간격)
 *
 * 페이지네이션과 세션 타입 필터를 지원합니다.
 *
 * 설계 핵심:
 * - SSE 구독과 API fetch를 독립된 이펙트로 분리하여,
 *   페이지/필터 변경 시 SSE 연결이 끊어지지 않도록 합니다.
 * - SSE delta 이벤트는 전역(페이지 무관)이므로 storageMode 변경 시에만 재연결합니다.
 */

import { useEffect, useRef, useCallback } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { getSessionProvider } from "../providers";
import type { SessionStreamEvent, SessionStatus } from "@shared/types";
import { toSessionSummary } from "@shared/mappers";

/** 서버가 named SSE event로 보내는 이벤트 타입 목록 */
const SESSION_STREAM_EVENT_TYPES = [
  "session_list",
  "session_created",
  "session_updated",
  "session_deleted",
] as const;

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
  const sessionsTotal = useDashboardStore((s) => s.sessionsTotal);
  const loading = useDashboardStore((s) => s.sessionsLoading);
  const error = useDashboardStore((s) => s.sessionsError);

  // 페이지네이션/필터 상태
  const sessionPage = useDashboardStore((s) => s.sessionPage);
  const sessionPageSize = useDashboardStore((s) => s.sessionPageSize);
  const sessionTypeFilter = useDashboardStore((s) => s.sessionTypeFilter);

  // 첫 로드 추적 (최초 마운트 시에만 로딩 표시, 이후 페이지/필터 변경은 백그라운드 갱신)
  const isFirstLoad = useRef(true);
  const abortRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  /**
   * 세션 목록을 API로 조회합니다.
   * 현재 페이지와 필터 상태를 반영합니다.
   */
  const fetchSessions = useCallback(async () => {
    // 최초 마운트 시에만 로딩 인디케이터 표시.
    // 페이지/필터 변경 시에는 백그라운드에서 데이터를 교체하여 깜빡임을 방지합니다.
    if (isFirstLoad.current) {
      setSessionsLoading(true);
    }

    try {
      abortRef.current = false;

      const provider = getSessionProvider(storageMode);
      const offset = sessionPage * sessionPageSize;
      const typeFilter = sessionTypeFilter === "all" ? undefined : sessionTypeFilter;
      const result = await provider.fetchSessions(offset, sessionPageSize, typeFilter);

      if (abortRef.current) return;

      setSessions(result.sessions, result.total);
    } catch (err: unknown) {
      if (abortRef.current) return;

      const message =
        err instanceof Error ? err.message : "세션 목록 조회 실패";
      setSessionsError(message);
    } finally {
      isFirstLoad.current = false;
      setSessionsLoading(false);
    }
  }, [storageMode, sessionPage, sessionPageSize, sessionTypeFilter, setSessions, setSessionsLoading, setSessionsError]);

  /**
   * SSE delta 이벤트 처리 (sse 모드)
   *
   * session_list는 무시하고, session_created/updated/deleted만 처리합니다.
   */
  const handleSSEEvent = useCallback(
    (event: SessionStreamEvent) => {
      setSessionsError(null);
      switch (event.type) {
        case "session_list":
          // 무시: fetchSessions API 호출로 대체
          break;

        case "session_created": {
          const newSession = toSessionSummary(event.session as unknown as Record<string, unknown>);
          // 현재 탭 필터와 일치하는 경우에만 목록에 추가
          const currentFilter = useDashboardStore.getState().sessionTypeFilter;
          if (currentFilter === "all" || newSession.sessionType === currentFilter) {
            addSession(newSession);
          }
          break;
        }

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
    [addSession, updateSession, removeSession, setSessionsError]
  );

  /**
   * SSE 연결 설정 (sse 모드 — delta 이벤트 수신용)
   */
  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) return;

    const eventSource = new EventSource("/api/sessions/stream");
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setSessionsError(null);
    };

    for (const eventType of SESSION_STREAM_EVENT_TYPES) {
      eventSource.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data) as SessionStreamEvent;
          handleSSEEvent(data);
        } catch {
          // JSON 파싱 실패: 무시
        }
      });
    }

    eventSource.onerror = () => {
      setSessionsError("세션 목록 연결이 끊어졌습니다. 자동 재연결 중...");
    };
  }, [handleSSEEvent, setSessionsError]);

  /**
   * SSE 연결 해제
   */
  const disconnectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  // Effect 1: API fetch — 페이지/필터 변경 시 데이터 조회 (SSE 연결에 영향 없음)
  useEffect(() => {
    if (!enabled) return;

    fetchSessions();

    return () => {
      abortRef.current = true;
    };
  }, [enabled, fetchSessions]);

  // Effect 2: SSE 구독 — storageMode 변경 시에만 재연결 (페이지/필터 변경과 무관)
  useEffect(() => {
    if (!enabled || storageMode !== "sse") return;

    connectSSE();

    return () => {
      disconnectSSE();
    };
  }, [enabled, storageMode, connectSSE, disconnectSSE]);

  // Effect 3: Serendipity 폴링 — storageMode가 serendipity일 때만 활성화
  useEffect(() => {
    if (!enabled || storageMode !== "serendipity") return;

    const timer = setInterval(fetchSessions, intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [enabled, storageMode, fetchSessions, intervalMs]);

  // storageMode 변경 시 첫 로드 플래그 리셋
  useEffect(() => {
    isFirstLoad.current = true;
  }, [storageMode]);

  return {
    sessions,
    sessionsTotal,
    loading,
    error,
    /** 수동 새로고침 */
    refetch: fetchSessions,
    storageMode,
  };
}
