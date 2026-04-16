/**
 * useSessionListProvider - Provider 기반 세션 목록 훅 (TanStack Query 기반)
 *
 * 현재 스토리지 모드에 따라 적절한 방식으로 세션 목록을 조회합니다:
 * - sse 모드: useInfiniteQuery + SSE delta 이벤트 (session_created/updated/deleted)
 * - serendipity 모드: useInfiniteQuery (5초 간격 refetch)
 *
 * 세션 타입 필터를 지원합니다.
 *
 * 설계 핵심:
 * - TanStack Query가 서버 상태(sessions 페이지 목록)를 관리한다.
 * - EventSource 연결/재연결은 useSessionStreamSSE 훅이 전담한다.
 * - SSE delta 이벤트 → 캐시/store 동기화는 useSessionStreamCacheSync 훅이 전담한다.
 */

import { useCallback, useState, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useDashboardStore } from "../stores/dashboard-store";
import type { SessionSummary } from "../shared/types";
import type { SessionStorageProvider, StorageMode } from "../providers/types";
import { useInitialCatalogLoad } from "./useInitialCatalogLoad";
import { useSessionStreamCacheSync } from "./useSessionStreamCacheSync";

const DEFAULT_PAGE_SIZE = 50;

interface SessionPage {
  sessions: SessionSummary[];
  total: number;
}

export interface UseSessionListProviderOptions {
  /** 폴링 간격 (ms). serendipity 모드에서만 사용. 기본 5000 */
  intervalMs?: number;
  /** 자동 조회/구독 활성화. 기본 true */
  enabled?: boolean;
  /** Provider 팩토리: storageMode를 받아 적절한 Provider를 반환 */
  getSessionProvider: (mode: StorageMode) => SessionStorageProvider;
  /**
   * 외부 세션 프로바이더. 지정하면 SSE/Serendipity 구독 대신
   * 이 프로바이더의 fetchSessions를 intervalMs 간격으로 폴링한다.
   */
  externalProvider?: SessionStorageProvider;
}

export function useSessionListProvider(
  options: UseSessionListProviderOptions
) {
  const {
    intervalMs = 5000,
    enabled = true,
    getSessionProvider,
    externalProvider,
  } = options;

  const storageMode = useDashboardStore((s) => s.storageMode);

  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({});

  // 필터 상태
  const sessionTypeFilter = useDashboardStore((s) => s.sessionTypeFilter);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);

  // 피드 뷰에서는 selectedFolderId 변경 시 재조회 불필요
  const effectiveFolderId = viewMode === "folder" ? selectedFolderId : null;

  // 현재 쿼리 키 — SSE setQueryData에서도 동일 키 사용
  const queryKey = useMemo(
    () => ["sessions", storageMode, sessionTypeFilter, viewMode, effectiveFolderId] as const,
    [storageMode, sessionTypeFilter, viewMode, effectiveFolderId],
  );

  // --- TanStack Query ---

  const isSSEEnabled =
    enabled &&
    (storageMode === "sse" || storageMode === "serendipity" || !!externalProvider);

  const {
    data,
    hasNextPage,
    fetchNextPage,
    isFetching,
    error,
    refetch: queryRefetch,
  } = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam = 0 }) => {
      const provider = externalProvider ?? getSessionProvider(storageMode);
      const typeFilter = sessionTypeFilter === "all" ? undefined : sessionTypeFilter;
      const { viewMode: currentViewMode, selectedFolderId: currentFolderId } =
        useDashboardStore.getState();
      const folderFilter =
        currentViewMode === "folder" && currentFolderId !== null
          ? { folderId: currentFolderId }
          : {};
      const result = await provider.fetchSessions({
        sessionType: typeFilter,
        offset: pageParam as number,
        limit: DEFAULT_PAGE_SIZE,
        ...folderFilter,
      });

      // 폴더별 세션 수 조회 (provider가 지원하는 경우)
      if (provider.fetchFolderCounts) {
        provider.fetchFolderCounts().then(setFolderCounts).catch(() => {});
      }

      return result as SessionPage;
    },
    initialPageParam: 0,
    getNextPageParam: (_lastPage, allPages) => {
      const loaded = allPages.reduce((sum, p) => sum + p.sessions.length, 0);
      const total = _lastPage.total;
      return loaded < total ? loaded : undefined;
    },
    enabled: isSSEEnabled,
    // serendipity 모드에서는 폴링 활성화
    refetchInterval:
      !externalProvider && storageMode === "serendipity" ? intervalMs : false,
    // externalProvider 폴링
    ...(externalProvider ? { refetchInterval: intervalMs } : {}),
    staleTime: storageMode === "sse" ? Infinity : 0,
  });

  // TanStack Query 데이터에서 sessions 추출
  const sessions = useMemo(
    () => data?.pages.flatMap((page) => page.sessions) ?? [],
    [data],
  );

  // sessionsTotal: 마지막 페이지의 total
  const sessionsTotal =
    data?.pages[data.pages.length - 1]?.total ?? 0;

  const hasMore = hasNextPage ?? false;

  const loadMore = useCallback(() => {
    fetchNextPage();
  }, [fetchNextPage]);

  // --- 초기 카탈로그 로드 ---
  useInitialCatalogLoad(enabled);

  // --- SSE 구독: 연결 + 캐시/store 동기화 ---
  useSessionStreamCacheSync({
    enabled: enabled && storageMode === "sse" && !externalProvider,
    url: `/api/sessions/stream?limit=${DEFAULT_PAGE_SIZE}`,
    queryKey,
    onReconnect: queryRefetch,
  });

  return {
    sessions,
    sessionsTotal,
    loading: isFetching && !data,
    error: error?.message ?? null,
    /** 추가 로드 가능 여부 */
    hasMore,
    /** 다음 페이지 세션 로드 */
    loadMore,
    /** 폴더별 세션 수 (서버 집계값, provider가 fetchFolderCounts를 지원하는 경우) */
    folderCounts,
    /** 수동 새로고침 */
    refetch: queryRefetch,
    storageMode,
  };
}
