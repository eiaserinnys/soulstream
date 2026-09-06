/**
 * useSessionStreamCacheSync
 *
 * SSE delta 이벤트를 받아 TanStack Query 캐시와 dashboard store를
 * 동기화하는 훅. EventSource 연결 자체는 useSessionStreamSSE가 관리한다.
 *
 * useSessionListProvider의 상세 로직(이벤트별 콜백)을 이쪽으로 옮겨
 * Provider 훅은 useInfiniteQuery 설정과 public API 반환에 집중한다.
 */

import { useCallback, useEffect, useRef } from "react";
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
  PageUpdatedStreamEvent,
  CustomViewUpdatedStreamEvent,
  ReplayGapStreamEvent,
  TaskUpdatedStreamEvent,
  SessionListStreamEvent,
  SessionCreatedStreamEvent,
  SessionDeletedStreamEvent,
  SessionUpdatedStreamEvent,
  SessionStreamEvent,
  StreamMetaStreamEvent,
} from "../shared/stream-events";
import {
  applyMetadataUpdated,
  applySessionLifecycleSnapshot,
  applySessionLifecycleSnapshotToList,
  applySessionCreated,
  mergeSessionCreatedSummary,
  applySessionDeleted,
  applySessionUpdatedEvent,
  buildSessionUpdates,
  findSessionInPages,
  mergeCatalogSessionsDelta,
  preserveCatalogSessionList,
  reconcileSessionPagesForCatalog,
  removeSessionFromCatalogSessionList,
  shouldApplySessionCreatedToCache,
  updateSessionInCatalogSessionList,
  upsertSessionAssignmentInCatalog,
  upsertSessionInCatalogSessionList,
} from "./session-stream-helpers";
import { useSessionStreamSSE } from "./useSessionStreamSSE";
import {
  applySessionFeedDelta,
  hydrateNoticeBaseline,
  takeLiveSessionNotices,
  type NoticeBaseline,
} from "./session-feed-projection";
import { appendBrowserNotices } from "../shared/browser-notices";

interface SessionPage {
  sessions: SessionSummary[];
  total: number;
}

const MAX_RECOVERY_EVENT_QUEUE = 10_000;
const RECOVERY_RETRY_BASE_MS = 1_000;
const RECOVERY_RETRY_MAX_MS = 30_000;

interface StreamRecovery {
  events: SessionStreamEvent[];
  restart: boolean;
  postInFlightRefetch: boolean;
  inFlight: boolean;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
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
  onStreamMeta?: (event: StreamMetaStreamEvent) => boolean | void;
  /** replay_gap 수신 시 호출 (풀 refetch 트리거용). */
  onReplayGap?: (event: ReplayGapStreamEvent) => boolean | void;
  /** task_updated 수신 시 호출 (업무 snapshot projection 갱신용). */
  onTaskUpdated?: (event: TaskUpdatedStreamEvent) => void;
  /** session_deleted 캐시 반영 뒤 detail cursor 같은 외부 projection을 회수한다. */
  onSessionDeleted?: (event: SessionDeletedStreamEvent) => void;
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

export type HydrateSessionSnapshots = (
  sessions: readonly SessionSummary[],
) => void;

export function useSessionStreamCacheSync(
  options: UseSessionStreamCacheSyncOptions,
): HydrateSessionSnapshots {
  const {
    enabled,
    urlBuilder,
    queryKey,
    onEventIdAdvance,
    onStreamMeta: onStreamMetaOption,
    onReplayGap: onReplayGapOption,
    onTaskUpdated: onTaskUpdatedOption,
    onSessionDeleted: onSessionDeletedOption,
    onCustomViewUpdated: onCustomViewUpdatedOption,
    onStreamEvent,
    transformCatalogUpdate,
  } = options;
  const queryClient = useQueryClient();
  const setActiveSessionSummary = useDashboardStore(
    (s) => s.setActiveSessionSummary,
  );
  const noticeBaselinesRef = useRef<Map<string, NoticeBaseline>>(new Map());
  const recoveryRef = useRef<StreamRecovery | null>(null);
  const runRecoveryRef = useRef<(recovery: StreamRecovery) => void>(() => undefined);

  useEffect(() => {
    if (!enabled) {
      const recovery = recoveryRef.current;
      if (recovery?.retryTimer) clearTimeout(recovery.retryTimer);
      recoveryRef.current = null;
    }
    return () => {
      const recovery = recoveryRef.current;
      if (recovery?.retryTimer) clearTimeout(recovery.retryTimer);
      recoveryRef.current = null;
    };
  }, [enabled]);

  const hydrateSessionSnapshots = useCallback((sessions: readonly SessionSummary[]) => {
    const snapshots = new Map(
      sessions.map((session) => [session.agentSessionId, session] as const),
    );
    for (const session of snapshots.values()) {
      hydrateNoticeBaseline(noticeBaselinesRef.current, session);
    }

    const state = useDashboardStore.getState();
    const activeSessionKey = state.activeSessionKey;
    if (activeSessionKey === null) return;
    const snapshot = snapshots.get(activeSessionKey);
    if (!snapshot) return;
    if (!state.activeSessionSummary) {
      setActiveSessionSummary(snapshot);
      return;
    }
    const [summary] = applySessionLifecycleSnapshotToList(
      [state.activeSessionSummary],
      snapshots,
    );
    if (summary !== state.activeSessionSummary) {
      setActiveSessionSummary(summary);
    }
  }, [setActiveSessionSummary]);

  const onSessionCreated = useCallback(
    (event: SessionCreatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      const newSession = toSessionSummary(
        event.session as unknown as Record<string, unknown>,
      );
      hydrateNoticeBaseline(noticeBaselinesRef.current, newSession);
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
      const liveNotices = takeLiveSessionNotices(noticeBaselinesRef.current, event);
      if (liveNotices.length > 0) {
        useDashboardStore.setState((current) => ({
          pendingNotifications: appendBrowserNotices(
            current.pendingNotifications,
            liveNotices,
          ),
        }));
      }
      const state = useDashboardStore.getState();
      if (state.catalog?.sessionList) {
        const current = state.catalog.sessionList.find(
          (session) => session.agentSessionId === event.agent_session_id,
        );
        state.setCatalog(updateSessionInCatalogSessionList(
          state.catalog,
          event.agent_session_id,
          current ? { ...updates, ...applySessionFeedDelta(current, event) } : updates,
        ));
      }

      queryClient.setQueriesData<InfiniteData<SessionPage>>(
        { queryKey: ["sessions"], exact: false },
        (old) => {
          if (!old) return old;
          return applySessionUpdatedEvent(old, event, updates);
        },
      );

      // activeSessionSummary 동기화
      const storeState = useDashboardStore.getState();
      if (event.agent_session_id !== storeState.activeSessionKey) return;
      if (storeState.activeSessionSummary) {
        setActiveSessionSummary({
          ...storeState.activeSessionSummary,
          ...updates,
          ...applySessionFeedDelta(storeState.activeSessionSummary, event),
        });
        return;
      }
      // ⚠️ URL 직접 진입 시 current가 null → 쿼리 캐시에서 bootstrap
      const allQueries = queryClient.getQueriesData<InfiniteData<SessionPage>>({
        queryKey: ["sessions"],
        exact: false,
      });
      const found = findSessionInPages(allQueries, event.agent_session_id);
      if (found) setActiveSessionSummary({
        ...found,
        ...updates,
        ...applySessionFeedDelta(found, event),
      });
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
      noticeBaselinesRef.current.delete(event.agent_session_id);
      onSessionDeletedOption?.(event);
    },
    [queryClient, onEventIdAdvance, onSessionDeletedOption],
  );

  const onCatalogUpdated = useCallback(
    (event: CatalogUpdatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      const store = useDashboardStore.getState();
      const incoming = event.catalog
        ?? (
          Array.isArray(event.folders)
          && event.sessions_delta !== undefined
          && event.board_items_delta !== undefined
            ? mergeCatalogSessionsDelta(
                store.catalog,
                event.folders,
                event.sessions_delta,
                event.board_items_delta,
              )
            : undefined
        );
      if (!incoming) return;
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
      void queryClient.invalidateQueries({
        queryKey: ["sessions"],
        exact: false,
        predicate: (query) => query.queryKey[2] !== "ids",
      });
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

  const onTaskUpdated = useCallback(
    (event: TaskUpdatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      onTaskUpdatedOption?.(event);
    },
    [onEventIdAdvance, onTaskUpdatedOption],
  );

  const onCustomViewUpdated = useCallback(
    (event: CustomViewUpdatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      onCustomViewUpdatedOption?.(event);
    },
    [onCustomViewUpdatedOption, onEventIdAdvance],
  );

  const onPageUpdated = useCallback(
    (event: PageUpdatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
    },
    [onEventIdAdvance],
  );

  const onSessionList = useCallback((event: SessionListStreamEvent) => {
    const lifecycleSnapshots = new Map(
      event.sessions.map((rawSession) => {
        const session = toSessionSummary(
          rawSession as unknown as Record<string, unknown>,
        );
        return [session.agentSessionId, session] as const;
      }),
    );
    for (const session of lifecycleSnapshots.values()) {
      hydrateNoticeBaseline(noticeBaselinesRef.current, session);
    }
    const state = useDashboardStore.getState();
    if (state.catalog?.sessionList) {
      const sessionList = applySessionLifecycleSnapshotToList(
        state.catalog.sessionList,
        lifecycleSnapshots,
      );
      if (sessionList !== state.catalog.sessionList) {
        state.setCatalog({ ...state.catalog, sessionList });
      }
    }

    queryClient.setQueriesData<InfiniteData<SessionPage>>(
      { queryKey: ["sessions"], exact: false },
      (old) => old
        ? applySessionLifecycleSnapshot(old, lifecycleSnapshots)
        : old,
    );

    const storeState = useDashboardStore.getState();
    const activeSessionKey = storeState.activeSessionKey;
    if (activeSessionKey === null || !lifecycleSnapshots.has(activeSessionKey)) return;
    if (storeState.activeSessionSummary) {
      const [summary] = applySessionLifecycleSnapshotToList(
        [storeState.activeSessionSummary],
        lifecycleSnapshots,
      );
      if (summary !== storeState.activeSessionSummary) {
        setActiveSessionSummary(summary);
      }
      return;
    }

    const allQueries = queryClient.getQueriesData<InfiniteData<SessionPage>>({
      queryKey: ["sessions"],
      exact: false,
    });
    const found = findSessionInPages(allQueries, activeSessionKey);
    if (found) setActiveSessionSummary(found);
  }, [queryClient, setActiveSessionSummary]);

  const applyDataEvent = useCallback((event: SessionStreamEvent) => {
    switch (event.type) {
      case "session_list":
        onSessionList(event);
        break;
      case "session_created":
        onSessionCreated(event);
        break;
      case "session_updated":
        onSessionUpdated(event);
        break;
      case "session_deleted":
        onSessionDeleted(event);
        break;
      case "catalog_updated":
        onCatalogUpdated(event);
        break;
      case "metadata_updated":
        onMetadataUpdated(event);
        break;
      case "task_updated":
        onTaskUpdated(event);
        break;
      case "custom_view_updated":
        onCustomViewUpdated(event);
        break;
      case "page_updated":
        onPageUpdated(event);
        break;
      case "runbook_updated":
      case "stream_meta":
      case "replay_gap":
        break;
    }
  }, [
    onCatalogUpdated,
    onCustomViewUpdated,
    onMetadataUpdated,
    onPageUpdated,
    onSessionCreated,
    onSessionDeleted,
    onSessionList,
    onSessionUpdated,
    onTaskUpdated,
  ]);

  const runRecovery = useCallback(async (recovery: StreamRecovery) => {
    if (recovery.inFlight || recoveryRef.current !== recovery) return;
    recovery.inFlight = true;
    try {
      do {
        recovery.restart = false;
        const allSessionFilters = {
          queryKey: ["sessions"],
          exact: false,
          type: "all" as const,
        };
        const filters = recovery.postInFlightRefetch
          ? allSessionFilters
          : {
              ...allSessionFilters,
              predicate: (query: { state: { data: unknown } }) => query.state.data === undefined,
            };
        const hadInitialFetchInFlight = queryClient.getQueryCache()
          .findAll(filters)
          .some((query) => query.state.fetchStatus === "fetching");
        await queryClient.refetchQueries({
          ...filters,
        }, {
          cancelRefetch: !hadInitialFetchInFlight,
          throwOnError: true,
        });
        // A gap can arrive during first-mount hydration. TanStack Query shares
        // that in-flight request instead of starting another one when there is
        // no cached data yet, so take the actual post-gap baseline afterward.
        if (
          recovery.postInFlightRefetch
          && hadInitialFetchInFlight
          && recoveryRef.current === recovery
          && !recovery.restart
        ) {
          await queryClient.refetchQueries(allSessionFilters, { throwOnError: true });
        }
        if (
          !recovery.postInFlightRefetch
          && queryClient.getQueryCache()
            .findAll({ queryKey: ["sessions"], exact: false })
            .some((query) => (
              query.state.data === undefined
              && query.state.fetchStatus === "fetching"
            ))
        ) {
          // A view/folder switch can create another first-load query while the
          // prior one is pending. Include it in the same initial barrier before
          // replaying the stream tail into every cache.
          recovery.restart = true;
        }
      } while (recoveryRef.current === recovery && recovery.restart);
    } catch {
      recovery.inFlight = false;
      if (recoveryRef.current !== recovery) return;
      const delay = Math.min(
        RECOVERY_RETRY_BASE_MS * 2 ** Math.min(recovery.retryAttempt, 5),
        RECOVERY_RETRY_MAX_MS,
      );
      recovery.retryAttempt += 1;
      recovery.retryTimer = setTimeout(() => {
        recovery.retryTimer = null;
        if (recoveryRef.current === recovery) runRecoveryRef.current(recovery);
      }, delay);
      return;
    }

    if (recoveryRef.current !== recovery) return;
    recovery.inFlight = false;
    recovery.retryAttempt = 0;
    const queued = recovery.events.splice(0);
    recoveryRef.current = null;
    for (const event of queued) {
      applyDataEvent(event);
      onStreamEvent?.(event);
    }
  }, [applyDataEvent, onStreamEvent, queryClient]);
  runRecoveryRef.current = (recovery) => {
    void runRecovery(recovery);
  };

  const requestRecovery = useCallback(() => {
    const current = recoveryRef.current;
    if (current) {
      // A later gap supersedes both the in-flight baseline and deltas queued
      // before that gap. Keep the barrier closed and take a fresh baseline.
      current.events.length = 0;
      current.restart = true;
      current.postInFlightRefetch = true;
      if (current.retryTimer) {
        clearTimeout(current.retryTimer);
        current.retryTimer = null;
        runRecoveryRef.current(current);
      }
      return;
    }
    const recovery: StreamRecovery = {
      events: [],
      restart: false,
      postInFlightRefetch: true,
      inFlight: false,
      retryAttempt: 0,
      retryTimer: null,
    };
    recoveryRef.current = recovery;
    void runRecovery(recovery);
  }, [runRecovery]);

  const routeDataEvent = useCallback((event: SessionStreamEvent) => {
    let recovery = recoveryRef.current;
    if (!recovery) {
      const hasUnhydratedSessionQuery = queryClient.getQueryCache()
        .findAll({ queryKey: ["sessions"], exact: false })
        .some((query) => (
          query.state.data === undefined
          && query.state.fetchStatus === "fetching"
        ));
      if (hasUnhydratedSessionQuery) {
        // The EventSource may deliver its initial snapshot/tail before the
        // first REST query commits. Queue that tail so the delayed REST value
        // cannot overwrite newer lifecycle/feed projections.
        recovery = {
          events: [],
          restart: false,
          postInFlightRefetch: false,
          inFlight: false,
          retryAttempt: 0,
          retryTimer: null,
        };
        recoveryRef.current = recovery;
        runRecoveryRef.current(recovery);
      }
    }
    if (recovery) {
      // Cursor ownership is independent from projection visibility. Advancing
      // it now prevents a reconnect from enqueueing the same buffered tail.
      if ("lastEventId" in event && event.lastEventId) {
        onEventIdAdvance?.(event.lastEventId);
      }
      if (recovery.events.length >= MAX_RECOVERY_EVENT_QUEUE) {
        // The current REST response can no longer be paired with a complete
        // delta tail. Drop that tail and require one more full baseline.
        recovery.events.length = 0;
        recovery.restart = true;
        recovery.postInFlightRefetch = true;
      }
      recovery.events.push(event);
      return;
    }
    applyDataEvent(event);
  }, [applyDataEvent, onEventIdAdvance, queryClient]);

  const onStreamMeta = useCallback((event: StreamMetaStreamEvent) => {
    if (onStreamMetaOption?.(event) === true) requestRecovery();
  }, [onStreamMetaOption, requestRecovery]);

  const onReplayGap = useCallback((event: ReplayGapStreamEvent) => {
    if (onReplayGapOption?.(event) === true) requestRecovery();
  }, [onReplayGapOption, requestRecovery]);

  const observeStreamEvent = useCallback((event: SessionStreamEvent) => {
    if (event.type === "stream_meta" || event.type === "replay_gap") {
      onStreamEvent?.(event);
      return;
    }
    // Type-specific dispatch queued this event while the REST barrier was
    // active. Observation is replayed with the event after hydration.
    if (!recoveryRef.current) onStreamEvent?.(event);
  }, [onStreamEvent]);

  useSessionStreamSSE({
    enabled,
    urlBuilder,
    onSessionList: routeDataEvent,
    onSessionCreated: routeDataEvent,
    onSessionUpdated: routeDataEvent,
    onSessionDeleted: routeDataEvent,
    onCatalogUpdated: routeDataEvent,
    onMetadataUpdated: routeDataEvent,
    onTaskUpdated: routeDataEvent,
    onCustomViewUpdated: routeDataEvent,
    onPageUpdated: routeDataEvent,
    onStreamMeta,
    onReplayGap,
    onEvent: observeStreamEvent,
  });
  return hydrateSessionSnapshots;
}
