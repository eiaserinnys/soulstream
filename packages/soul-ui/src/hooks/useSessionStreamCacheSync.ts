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
  ReplayGapStreamEvent,
  SessionCreatedStreamEvent,
  SessionDeletedStreamEvent,
  SessionUpdatedStreamEvent,
  StreamMetaStreamEvent,
} from "../shared/stream-events";
import {
  applyMetadataUpdated,
  applySessionCreated,
  applySessionDeleted,
  applySessionUpdated,
  buildSessionUpdates,
  findSessionInPages,
  upsertSessionAssignmentInCatalog,
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
  } = options;
  const queryClient = useQueryClient();
  const setActiveSessionSummary = useDashboardStore(
    (s) => s.setActiveSessionSummary,
  );

  const onSessionCreated = useCallback(
    (event: SessionCreatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      console.log(`[⚡ SSE] type=session_created`);
      const newSession = toSessionSummary(
        event.session as unknown as Record<string, unknown>,
      );
      // 서버가 folder_id를 함께 실어주는 경우가 있어 동적으로 읽는다.
      const folderId = (event as Record<string, unknown>).folder_id as
        | string
        | undefined;

      const state = useDashboardStore.getState();
      if (folderId && state.catalog) {
        state.setCatalog(
          upsertSessionAssignmentInCatalog(
            state.catalog,
            newSession.agentSessionId,
            folderId,
          ),
        );
      }

      // 폴더 뷰에서는 현재 폴더에 속한 세션만 캐시에 추가
      if (
        state.viewMode === "folder" &&
        state.selectedFolderId !== null &&
        folderId !== state.selectedFolderId
      ) {
        return;
      }

      queryClient.setQueryData(
        queryKey,
        (old: InfiniteData<SessionPage> | undefined) => {
          if (!old) return old;
          return applySessionCreated(old, newSession, state.sessionTypeFilter);
        },
      );
    },
    [queryClient, queryKey, onEventIdAdvance],
  );

  const onSessionUpdated = useCallback(
    (event: SessionUpdatedStreamEvent) => {
      if (event.lastEventId) onEventIdAdvance?.(event.lastEventId);
      console.log(`[⚡ SSE] type=session_updated`);
      const updates = buildSessionUpdates(event);

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
      console.log(`[⚡ SSE] session_deleted → ${event.agent_session_id}`);
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
      console.log(
        `[⚡ SSE] catalog_updated → folders=${event.catalog?.folders?.length}, sessions=${Object.keys(event.catalog?.sessions ?? {}).length}`,
      );
      useDashboardStore.getState().setCatalog(event.catalog as CatalogState);
    },
    [onEventIdAdvance],
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

  const onSessionList = useCallback(() => {
    // 무시: TanStack Query fetch로 대체
    console.log(`[⚡ SSE] type=session_list (무시)`);
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
    onStreamMeta,
    onReplayGap,
  });
}
