/**
 * useSessionListProvider - Provider 기반 세션 목록 훅 (TanStack Query 기반)
 *
 * useInfiniteQuery + SSE delta 이벤트 (session_created/updated/deleted)로
 * 세션 목록을 조회하고 실시간 동기화합니다.
 *
 * 세션 타입 필터를 지원합니다.
 *
 * 설계 핵심:
 * - TanStack Query가 서버 상태(sessions 페이지 목록)를 관리한다.
 * - EventSource 연결/재연결은 useSessionStreamSSE 훅이 전담한다.
 * - SSE delta 이벤트 → 캐시/store 동기화는 useSessionStreamCacheSync 훅이 전담한다.
 */

import { useCallback, useRef, useState, useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useDashboardStore } from "../stores/dashboard-store";
import type { SessionSummary } from "../shared/types";
import type { SessionStorageProvider } from "../providers/types";
import { useInitialCatalogLoad } from "./useInitialCatalogLoad";
import { useSessionStreamCacheSync } from "./useSessionStreamCacheSync";
import {
  buildCatalogStreamUrl,
  reconcileReplayGap,
  reconcileStreamMeta,
} from "./catalog-stream-resume";

const DEFAULT_PAGE_SIZE = 50;

interface SessionPage {
  sessions: SessionSummary[];
  total: number;
}

export interface UseSessionListProviderOptions {
  /** 폴링 간격 (ms). externalProvider 폴링에서만 사용. 기본 5000 */
  intervalMs?: number;
  /** 자동 조회/구독 활성화. 기본 true */
  enabled?: boolean;
  /** Provider 팩토리 */
  getSessionProvider: () => SessionStorageProvider;
  /**
   * 외부 세션 프로바이더. 지정하면 SSE 구독 대신
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

  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({});

  // 필터 상태
  const sessionTypeFilter = useDashboardStore((s) => s.sessionTypeFilter);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);

  // 피드 뷰에서는 selectedFolderId 변경 시 재조회 불필요
  const effectiveFolderId = viewMode === "folder" ? selectedFolderId : null;

  // 현재 쿼리 키 — SSE setQueryData에서도 동일 키 사용
  const queryKey = useMemo(
    () => ["sessions", sessionTypeFilter, viewMode, effectiveFolderId] as const,
    [sessionTypeFilter, viewMode, effectiveFolderId],
  );

  // --- TanStack Query ---

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
      const provider = externalProvider ?? getSessionProvider();
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
    enabled,
    // externalProvider 폴링
    refetchInterval: externalProvider ? intervalMs : false,
    staleTime: externalProvider ? 0 : Infinity,
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

  // --- Last-Event-ID resume 정본 (provider 레벨) ---
  // 매 SSE id 부착 이벤트마다 lastEventIdRef를 갱신, instance_id 변경/replay_gap
  // 수신 시 lastEventIdRef를 latest_id로 끌어올리고 queryRefetch.
  // 두 ref는 useSessionStreamSSE 재연결 시 urlBuilder를 통해 자연스럽게 query에 부착된다.
  const lastEventIdRef = useRef<string | undefined>(undefined);
  const instanceIdRef = useRef<string | undefined>(undefined);

  // --- SSE 구독: 연결 + 캐시/store 동기화 ---
  useSessionStreamCacheSync({
    enabled: enabled && !externalProvider,
    urlBuilder: () =>
      buildCatalogStreamUrl(lastEventIdRef.current, instanceIdRef.current),
    queryKey,
    onEventIdAdvance: (eid) => {
      // SSE id 부착 이벤트만 cache-sync 내부 가드를 통과해 도달 → e.lastEventId
      // 빈 값 자동 skip. parseInt(NaN) 오염 회피.
      lastEventIdRef.current = eid;
    },
    onStreamMeta: (e) => {
      const update = reconcileStreamMeta(e, {
        instanceId: instanceIdRef.current,
        lastEventId: lastEventIdRef.current,
      });
      if (!update) return;
      instanceIdRef.current = update.nextInstanceId;
      lastEventIdRef.current = update.nextLastEventId;
      if (update.shouldRefetch) queryRefetch();
    },
    onReplayGap: (e) => {
      const update = reconcileReplayGap(e);
      lastEventIdRef.current = update.nextLastEventId;
      if (update.shouldRefetch) queryRefetch();
    },
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
  };
}
