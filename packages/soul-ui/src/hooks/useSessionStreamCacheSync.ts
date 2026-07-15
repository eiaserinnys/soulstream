/**
 * useSessionStreamCacheSync
 *
 * SSE delta 이벤트를 받아 TanStack Query 캐시와 dashboard store를
 * 동기화하는 훅. EventSource 연결 자체는 useSessionStreamSSE가 관리한다.
 *
 * useSessionListProvider의 상세 로직(이벤트별 콜백)을 이쪽으로 옮겨
 * Provider 훅은 useInfiniteQuery 설정과 public API 반환에 집중한다.
 */

import { useCallback } from "react";
import {
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from "@tanstack/react-query";
import { useDashboardStore } from "../stores/dashboard-store";
import { toSessionSummary } from "../shared/mappers";
import type {
  CatalogState,
  SessionSummary,
} from "../shared/types";
import type {
  CatalogUpdatedStreamEvent,
  MetadataUpdatedStreamEvent,
  CustomViewUpdatedStreamEvent,
  ReplayGapStreamEvent,
  RunbookUpdatedStreamEvent,
  SessionCreatedStreamEvent,
  SessionDeletedStreamEvent,
  SessionUpdatedStreamEvent,
  SessionStreamEvent,
  StreamMetaStreamEvent,
} from "../shared/stream-events";
import {
  applyMetadataUpdated,
  applySessionCreated,
  mergeSessionCreatedSummary,
  applySessionDeleted,
  applySessionUpdated,
  buildSessionUpdates,
  findSessionInPages,
  preserveCatalogSessionList,
  reconcileSessionPagesForCatalog,
  removeSessionFromCatalogSessionList,
  shouldApplySessionCreatedToCache,
  updateSessionInCatalogSessionList,
  upsertSessionAssignmentInCatalog,
  upsertSessionInCatalogSessionList,
} from "./session-stream-helpers";
import { useSessionStreamSSE } from "./useSessionStreamSSE";

interface SessionPage {
  sessions: SessionSummary[];
  total: number;
}

export interface UseSessionStreamCacheSyncOptions {
  /** 구독 활성화 여부. false면 연결하지 않는다. */
  enabled: boolean;
  /**
   * 매 connect 시 호출되어 SSE URL을 반환한다 (Last-Event-ID/instance_id 동적 부착용).
   * 이 옵션은 useSessionStreamSSE에 그대로 패스스루된다.
   */
  urlBuilder: () => string;
  /** session_created 이벤트 수신 시 현재 뷰의 queryKey (setQueryData 대상). */
  queryKey: QueryKey;
  /**
   * SSE id 부착 이벤트(session_created/updated/deleted/catalog_updated/metadata_updated) 수신 시
   * 호출되어 호출자가 lastEventId 정본을 갱신하도록 한다. e.lastEventId가 빈 값이면 호출되지 않는다.
   */
  onEventIdAdvance?: (lastEventId: string) => void;
  /** stream_meta 수신 시 호출 (instance_id 변경 감지용). */
  onStreamMeta?: (event: StreamMetaStreamEvent) => void;
  /** replay_gap 수신 시 호출 (풀 refetch 트리거용). */
  onReplayGap?: (event: ReplayGapStreamEvent) => void;
  /** runbook_updated 수신 시 호출 (런북 snapshot projection 갱신용). */
  onRunbookUpdated?: (event: RunbookUpdatedStreamEvent) => void;
  /** custom_view_updated 수신 시 호출 (커스텀 뷰 projection 갱신용). */
  onCustomViewUpdated?: (event: CustomViewUpdatedStreamEvent) => void;
  /** 모든 stream event의 타입별 캐시 처리가 끝난 뒤 호출한다. */
  onStreamEvent?: (event: SessionStreamEvent) => void;
  /** scoped surface가 catalog projection을 제한할 때만 결과를 반환한다. */
  transformCatalogUpdate?: (
    incoming: CatalogState,
    current: CatalogState | null,
  ) => CatalogState | undefined;
}

export function useSessionStreamCacheSync(
  options: UseSessionStreamCacheSyncOptions,
): void {
  const {
    enabled,
    urlBuilder,
    queryKey,
    onEventIdAdvance,
    onStreamMeta,
    onReplayGap,
    onRunbookUpdated: onRunbookUpdatedOption,
    onCustomViewUpdated: onCustomViewUpdatedOption,
    onStreamEvent,
    transformCatalogUpdate,
  } = options;
  const queryClient = useQueryClient();
  const setActiveSessionSummary = useDashboardStore(
    (s) => s.setActiveSessionSummary,
  );

  const onSessionCreated = useCallback(
    (event: SessionCreatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      const newSession = toSessionSummary(
        event.session as unknown as Record<string, unknown>,
      );
      // 서버가 folder_id를 함께 실어주는 경우가 있어 동적으로 읽는다.
      const eventRecord = event as unknown as Record<string, unknown>;
      const folderId = (eventRecord.folder_id ?? eventRecord.folderId) as
        | string
        | null
        | undefined;

      const state = useDashboardStore.getState();
      let catalogForCache = state.catalog;
      if (state.catalog) {
        catalogForCache = folderId !== undefined
          ? upsertSessionAssignmentInCatalog(
              state.catalog,
              newSession.agentSessionId,
              folderId,
              newSession,
            )
          : upsertSessionInCatalogSessionList(state.catalog, newSession);
        state.setCatalog(catalogForCache);
      }

      // F-A(2026-05-17): onSessionUpdated/onSessionDeleted와 대칭으로 모든
      // ["sessions", ...] 캐시에 적용. queryKey 차원(typeFilter, viewMode, folderId)별
      // 적합성을 predicate가 결정적으로 검사 — 변경 전 store-state 폴더 분기는
      // 같은 invariant를 중복 검사하던 이중 가드(design-principles §5)라 제거.
      // queryKey 구조: ["sessions", sessionTypeFilter, viewMode, effectiveFolderId]
      // (useSessionListProvider.ts L70-73).
      // 회귀 진단 정본: analysis/20260516-1707-dashboard-feed-realtime-regression §5.2 F-A.
      queryClient.setQueriesData<InfiniteData<SessionPage>>(
        {
          queryKey: ["sessions"],
          exact: false,
          predicate: (query) =>
            shouldApplySessionCreatedToCache(
              query.queryKey,
              newSession.sessionType,
              folderId,
              catalogForCache,
              newSession.agentSessionId,
            ),
        },
        (old) => {
          if (!old) return old;
          // predicate가 cache 차원 적합성을 결정적으로 검사 — applySessionCreated는
          // prepend·dedup만 책임 (design-principles §3 정본 하나, §5 제어의 단일 경로).
          return applySessionCreated(old, newSession);
        },
      );

      // activeSessionSummary 동기화 (사이클 A — 낙관적 세션 ↔ 서버 정본 race fix):
      // URL 직접 진입 또는 새 세션 생성 직후 active가 임시 세션인 상태에서 server
      // `session_created`가 도착하면 *정의된 server 필드로 덮어쓴다*. session_updated와
      // 대칭으로 onSessionCreated에도 active 동기화. 분석 캐시
      // `20260518-1405-cycle-a-optimistic-session-merge.md`.
      //
      // onSessionUpdated와의 의미 수준 대칭 (spec-reviewer P2-4): session_created는
      // newSession 자체가 *정본 전체*이므로 활성 summary 부재 시 `newSession`을 그대로 박는다.
      // session_updated는 *diff(updates)*만 운반하므로 캐시 폴백(findSessionInPages)으로 baseline을
      // 합쳐야 한다 — 두 분기 구조가 다른 것은 wire 의미 차이의 정합.
      const storeState = useDashboardStore.getState();
      if (storeState.activeSessionKey === newSession.agentSessionId) {
        if (storeState.activeSessionSummary) {
          setActiveSessionSummary(
            mergeSessionCreatedSummary(storeState.activeSessionSummary, newSession),
          );
        } else {
          setActiveSessionSummary(newSession);
        }
      }
    },
    [queryClient, setActiveSessionSummary, onEventIdAdvance],
  );

  const onSessionUpdated = useCallback(
    (event: SessionUpdatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      const updates = buildSessionUpdates(event);
      const state = useDashboardStore.getState();
      if (state.catalog?.sessionList) {
        state.setCatalog(updateSessionInCatalogSessionList(
          state.catalog,
          event.agent_session_id,
          updates,
        ));
      }

      queryClient.setQueriesData<InfiniteData<SessionPage>>(
        { queryKey: ["sessions"], exact: false },
        (old) => {
          if (!old) return old;
          return applySessionUpdated(old, event.agent_session_id, updates);
        },
      );

      // activeSessionSummary 동기화
      const storeState = useDashboardStore.getState();
      if (event.agent_session_id !== storeState.activeSessionKey) return;
      if (storeState.activeSessionSummary) {
        setActiveSessionSummary({
          ...storeState.activeSessionSummary,
          ...updates,
        });
        return;
      }
      // ⚠️ URL 직접 진입 시 current가 null → 쿼리 캐시에서 bootstrap
      const allQueries = queryClient.getQueriesData<InfiniteData<SessionPage>>({
        queryKey: ["sessions"],
        exact: false,
      });
      const found = findSessionInPages(allQueries, event.agent_session_id);
      if (found) setActiveSessionSummary({ ...found, ...updates });
    },
    [queryClient, setActiveSessionSummary, onEventIdAdvance],
  );

  const onSessionDeleted = useCallback(
    (event: SessionDeletedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      const state = useDashboardStore.getState();
      if (state.catalog?.sessionList) {
        state.setCatalog(removeSessionFromCatalogSessionList(
          state.catalog,
          event.agent_session_id,
        ));
      }
      queryClient.setQueriesData<InfiniteData<SessionPage>>(
        { queryKey: ["sessions"], exact: false },
        (old) => {
          if (!old) return old;
          return applySessionDeleted(old, event.agent_session_id);
        },
      );
    },
    [queryClient, onEventIdAdvance],
  );

  const onCatalogUpdated = useCallback(
    (event: CatalogUpdatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      const store = useDashboardStore.getState();
      const incoming = event.catalog as CatalogState;
      const catalog = transformCatalogUpdate?.(incoming, store.catalog)
        ?? preserveCatalogSessionList(incoming, store.catalog);
      store.setCatalog(catalog);
      for (const [cacheQueryKey, data] of queryClient.getQueriesData<
        InfiniteData<SessionPage>
      >({ queryKey: ["sessions"], exact: false })) {
        if (!data) continue;
        queryClient.setQueryData(
          cacheQueryKey,
          reconcileSessionPagesForCatalog(data, cacheQueryKey, catalog),
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["sessions"], exact: false });
    },
    [queryClient, onEventIdAdvance, transformCatalogUpdate],
  );

  const onMetadataUpdated = useCallback(
    (event: MetadataUpdatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      queryClient.setQueriesData<InfiniteData<SessionPage>>(
        { queryKey: ["sessions"], exact: false },
        (old) => {
          if (!old) return old;
          return applyMetadataUpdated(old, event.session_id, event.metadata);
        },
      );
    },
    [queryClient, onEventIdAdvance],
  );

  const onRunbookUpdated = useCallback(
    (event: RunbookUpdatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      onRunbookUpdatedOption?.(event);
    },
    [onEventIdAdvance, onRunbookUpdatedOption],
  );

  const onCustomViewUpdated = useCallback(
    (event: CustomViewUpdatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      onCustomViewUpdatedOption?.(event);
    },
    [onCustomViewUpdatedOption, onEventIdAdvance],
  );

  const onSessionList = useCallback(() => {
    // 무시: TanStack Query fetch로 대체
  }, []);

  useSessionStreamSSE({
    enabled,
    urlBuilder,
    onSessionList,
    onSessionCreated,
    onSessionUpdated,
    onSessionDeleted,
    onCatalogUpdated,
    onMetadataUpdated,
    onRunbookUpdated,
    onCustomViewUpdated,
    onStreamMeta,
    onReplayGap,
    onEvent: onStreamEvent,
  });
}
