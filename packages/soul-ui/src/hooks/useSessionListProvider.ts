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
import { useRunbookStore } from "../stores/runbook-store";
import { useCustomViewStore } from "../stores/custom-view-store";
import type { DashboardState } from "../stores/dashboard-store-types";
import type { SessionSummary } from "../shared/types";
import type { SessionStorageProvider } from "../providers/types";
import { useInitialCatalogLoad } from "./useInitialCatalogLoad";
import { useSessionStreamCacheSync } from "./useSessionStreamCacheSync";
import {
  buildCatalogStreamUrl,
  reconcileReplayGap,
  reconcileStreamMeta,
} from "./catalog-stream-resume";
import {
  buildFetchSessionsOptions,
  type SessionListQueryKey,
} from "./session-list-query";
import {
  countLoadedSessionsForQuery,
  mergeSessionAssignmentsFromSummaries,
} from "./session-stream-helpers";

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
  /**
   * Store의 현재 viewMode와 별개로 고정 조회할 목록 종류.
   * 좌측 사이드바 피드처럼 중앙 표면 네비게이션과 독립된 목록에서 사용한다.
   */
  viewModeOverride?: DashboardState["viewMode"];
  /** viewModeOverride와 함께 사용할 폴더 ID. null을 명시하면 미분류/전역 의미를 유지한다. */
  folderIdOverride?: string | null;
  /** catalog SSE 구독 활성화. 기본 true */
  streamEnabled?: boolean;
  /** 초기 catalog 로드 활성화. 기본 true */
  initialCatalogLoadEnabled?: boolean;
  /** 폴더 카운트 조회 활성화. 기본 true */
  folderCountsEnabled?: boolean;
  /** page/run history가 가리키는 세션 요약만 조회한다. */
  sessionIds?: readonly string[];
}

export function useSessionListProvider(
  options: UseSessionListProviderOptions
) {
  const {
    intervalMs = 5000,
    enabled = true,
    getSessionProvider,
    externalProvider,
    viewModeOverride,
    folderIdOverride,
    streamEnabled = true,
    initialCatalogLoadEnabled = true,
    folderCountsEnabled = true,
    sessionIds,
  } = options;

  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({});
  const handleRunbookUpdated = useRunbookStore((s) => s.handleRunbookUpdated);
  const handleCustomViewUpdated = useCustomViewStore((s) => s.handleCustomViewUpdated);

  // 필터 상태
  const sessionTypeFilter = useDashboardStore((s) => s.sessionTypeFilter);
  const storeViewMode = useDashboardStore((s) => s.viewMode);
  const storeSelectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const viewMode = viewModeOverride ?? storeViewMode;
  const selectedFolderId = Object.prototype.hasOwnProperty.call(
    options,
    "folderIdOverride",
  )
    ? (folderIdOverride ?? null)
    : storeSelectedFolderId;

  // 피드 뷰에서는 selectedFolderId 변경 시 재조회 불필요
  const effectiveFolderId = viewMode === "folder" ? selectedFolderId : null;

  // 현재 쿼리 키 — SSE setQueryData에서도 동일 키 사용
  const normalizedSessionIds = useMemo(
    () => sessionIds === undefined
      ? undefined
      : [...new Set(sessionIds.filter((sessionId) => sessionId.length > 0))].sort(),
    [sessionIds],
  );
  const queryKey = useMemo<SessionListQueryKey>(
    () => normalizedSessionIds !== undefined
      ? ["sessions", "all", "ids", null, normalizedSessionIds]
      : ["sessions", sessionTypeFilter, viewMode, effectiveFolderId],
    [normalizedSessionIds, sessionTypeFilter, viewMode, effectiveFolderId],
  );
  const pageSize = DEFAULT_PAGE_SIZE;

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
    queryFn: async ({ pageParam = 0, queryKey: fetchQueryKey }) => {
      const fetchOptions = buildFetchSessionsOptions(
        fetchQueryKey as SessionListQueryKey,
        pageParam as number,
        pageSize,
      );
      if (fetchOptions.sessionIds?.length === 0) {
        return { sessions: [], total: 0 } satisfies SessionPage;
      }
      const provider = externalProvider ?? getSessionProvider();
      // The query key is the request snapshot. Reading the live store here can
      // put feed data into a folder cache, or folder data into a feed cache.
      const result = await provider.fetchSessions(
        fetchOptions,
      );

      const store = useDashboardStore.getState();
      if (store.catalog) {
        const nextCatalog = mergeSessionAssignmentsFromSummaries(
          store.catalog,
          result.sessions,
        );
        if (nextCatalog !== store.catalog) {
          store.setCatalog(nextCatalog);
        }
      }

      // 폴더별 세션 수 조회 (provider가 지원하는 경우)
      if (folderCountsEnabled && provider.fetchFolderCounts) {
        provider.fetchFolderCounts().then(setFolderCounts).catch(() => {});
      }

      return result as SessionPage;
    },
    initialPageParam: 0,
    getNextPageParam: (_lastPage, allPages) => {
      const loaded = countLoadedSessionsForQuery(
        allPages,
        queryKey,
        useDashboardStore.getState().catalog,
      );
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
    return fetchNextPage();
  }, [fetchNextPage]);

  // --- 초기 카탈로그 로드 ---
  const catalogLoad = useInitialCatalogLoad(enabled && initialCatalogLoadEnabled) ?? {
    status: "idle" as const,
    message: null,
  };

  // --- Last-Event-ID resume 정본 (provider 레벨) ---
  // 매 SSE id 부착 이벤트마다 lastEventIdRef를 갱신, instance_id 변경/replay_gap
  // 수신 시 lastEventIdRef를 latest_id로 끌어올리고 queryRefetch.
  // 두 ref는 useSessionStreamSSE 재연결 시 urlBuilder를 통해 자연스럽게 query에 부착된다.
  const lastEventIdRef = useRef<string | undefined>(undefined);
  const instanceIdRef = useRef<string | undefined>(undefined);

  // --- SSE 구독: 연결 + 캐시/store 동기화 ---
  useSessionStreamCacheSync({
    enabled: enabled && streamEnabled && !externalProvider,
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
    onRunbookUpdated: handleRunbookUpdated,
    onCustomViewUpdated: handleCustomViewUpdated,
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
    /** legacy virtual page가 loading/auth/permission/error를 구분하는 기존 catalog load 상태 */
    catalogLoad,
  };
}
