/**
 * useSessionListProvider - Provider 기반 세션 목록 훅
 *
 * 현재 스토리지 모드에 따라 적절한 Provider를 사용하여
 * 세션 목록을 조회합니다.
 */

import { useEffect, useRef, useCallback } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { getSessionProvider } from "../providers";

interface UseSessionListProviderOptions {
  /** 폴링 간격 (ms). 기본 5000 */
  intervalMs?: number;
  /** 자동 폴링 활성화. 기본 true */
  enabled?: boolean;
}

export function useSessionListProvider(
  options: UseSessionListProviderOptions = {}
) {
  const { intervalMs = 5000, enabled = true } = options;

  const storageMode = useDashboardStore((s) => s.storageMode);
  const setSessions = useDashboardStore((s) => s.setSessions);
  const setSessionsLoading = useDashboardStore((s) => s.setSessionsLoading);
  const setSessionsError = useDashboardStore((s) => s.setSessionsError);

  const sessions = useDashboardStore((s) => s.sessions);
  const loading = useDashboardStore((s) => s.sessionsLoading);
  const error = useDashboardStore((s) => s.sessionsError);

  // 첫 로드 추적 (초기엔 로딩 표시, 이후엔 백그라운드 갱신)
  const isFirstLoad = useRef(true);
  const abortRef = useRef(false);

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

  // 마운트 시 즉시 조회 + 폴링
  useEffect(() => {
    if (!enabled) return;

    // 모드 변경 시 첫 로드 플래그 리셋
    isFirstLoad.current = true;

    // 즉시 1회 조회
    fetchSessions();

    // 인터벌 폴링
    const timer = setInterval(fetchSessions, intervalMs);

    return () => {
      clearInterval(timer);
      abortRef.current = true;
    };
  }, [fetchSessions, intervalMs, enabled, storageMode]);

  return {
    sessions,
    loading,
    error,
    refetch: fetchSessions,
    storageMode,
  };
}
