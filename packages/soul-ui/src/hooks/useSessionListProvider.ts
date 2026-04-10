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
 * - SSE delta 이벤트는 queryClient.setQueryData로 캐시를 직접 수정한다.
 * - store의 sessions 상태는 내부 로직(processEvent, addOptimisticSession 등) 호환성을 위해 유지한다.
 * - SSE 연결은 storageMode 변경 시에만 재연결된다.
 */

import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useDashboardStore } from "../stores/dashboard-store";
import { toSessionSummary } from "../shared/mappers";
import { SYSTEM_FOLDERS } from "../shared/constants";
import type {
  SessionStreamEvent,
  SessionStatus,
  SessionSummary,
} from "../shared/types";
import type { SessionStorageProvider, StorageMode } from "../providers/types";
import {
  applySessionCreated,
  applySessionUpdated,
  applySessionDeleted,
} from "./session-stream-helpers";

const DEFAULT_PAGE_SIZE = 50;

/** 서버가 named SSE event로 보내는 이벤트 타입 목록 */
const SESSION_STREAM_EVENT_TYPES = [
  "session_list",
  "session_created",
  "session_updated",
  "session_deleted",
  "catalog_updated",
  "metadata_updated",
] as const;

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

  const queryClient = useQueryClient();

  const storageMode = useDashboardStore((s) => s.storageMode);
  const setSessions = useDashboardStore((s) => s.setSessions);
  const addSession = useDashboardStore((s) => s.addSession);
  const updateSession = useDashboardStore((s) => s.updateSession);
  const removeSession = useDashboardStore((s) => s.removeSession);
  const setActiveSessionSummary = useDashboardStore((s) => s.setActiveSessionSummary);

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

  // SSE 관련 ref
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);

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
      const feedFilter = currentViewMode === "feed" ? { feedOnly: true } : {};
      const result = await provider.fetchSessions({
        sessionType: typeFilter,
        offset: pageParam as number,
        limit: DEFAULT_PAGE_SIZE,
        ...folderFilter,
        ...feedFilter,
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

  // Zustand store에 sessions 동기화 (다른 컴포넌트들의 하위 호환성 유지)
  const prevSessionsRef = useRef<SessionSummary[]>([]);
  useEffect(() => {
    if (sessions === prevSessionsRef.current) return;
    prevSessionsRef.current = sessions;
    setSessions(sessions, sessionsTotal);
  }, [sessions, sessionsTotal, setSessions]);

  // hasMore
  const hasMore = hasNextPage ?? false;

  // loadMore
  const loadMore = useCallback(() => {
    fetchNextPage();
  }, [fetchNextPage]);

  // --- 초기 카탈로그 로드 ---
  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();

    fetch("/api/catalog", { signal: controller.signal })
      .then((r) => {
        if (r.ok) return r.json();
        throw new Error("catalog fetch failed");
      })
      .then((data) => {
        if (data?.folders && data?.sessions) {
          const store = useDashboardStore.getState();
          store.setCatalog(data);

          if (
            store.selectedFolderId === null &&
            !store.activeSessionKey &&
            store.viewMode !== "feed"
          ) {
            const claudeFolder = data.folders.find(
              (f: { name: string }) => f.name === SYSTEM_FOLDERS.claude,
            );
            const defaultFolderId =
              claudeFolder?.id ?? data.folders[0]?.id ?? null;
            if (defaultFolderId) {
              useDashboardStore.getState().selectFolder(defaultFolderId);
            }
          }
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
      });

    return () => {
      controller.abort();
    };
  }, [enabled]);

  // --- SSE delta 이벤트 처리 ---
  const handleSSEEvent = useCallback(
    (event: SessionStreamEvent) => {
      console.log(
        `[⚡ SSE] type=${event.type}`,
        event.type === "session_list" ? `(무시)` : "",
      );
      switch (event.type) {
        case "session_list":
          // 무시: TanStack Query fetch로 대체
          break;

        case "session_created": {
          const newSession = toSessionSummary(
            event.session as unknown as Record<string, unknown>,
          );
          // folder_id가 있으면 catalog.sessions에 낙관적으로 반영
          const folderId = (event as Record<string, unknown>).folder_id as
            | string
            | undefined;
          if (folderId) {
            const state = useDashboardStore.getState();
            if (state.catalog) {
              state.setCatalog({
                ...state.catalog,
                sessions: {
                  ...state.catalog.sessions,
                  [newSession.agentSessionId]: { folderId, displayName: null },
                },
              });
            }
          }

          const currentFilter = useDashboardStore.getState().sessionTypeFilter;

          // TanStack Query 캐시 업데이트
          queryClient.setQueryData(
            queryKey,
            (old: InfiniteData<SessionPage> | undefined) => {
              if (!old) return old;
              return applySessionCreated(old, newSession, currentFilter);
            },
          );

          // store 동기화 (addSession은 중복 처리 포함)
          if (currentFilter === "all" || newSession.sessionType === currentFilter) {
            addSession(newSession);
          }
          break;
        }

        case "session_updated": {
          const updates: Parameters<typeof updateSession>[1] = {};
          if (event.status != null) {
            updates.status = event.status as SessionStatus;
          }
          if (event.updated_at != null) {
            updates.updatedAt = event.updated_at;
          }
          if (event.last_message) {
            updates.lastMessage = {
              type: event.last_message.type,
              preview: event.last_message.preview,
              timestamp: event.last_message.timestamp,
            };
          }
          if (event.last_event_id != null) {
            updates.lastEventId = event.last_event_id;
          }
          if (event.last_read_event_id != null) {
            updates.lastReadEventId = event.last_read_event_id;
          }

          // TanStack Query 캐시 업데이트
          queryClient.setQueryData(
            queryKey,
            (old: InfiniteData<SessionPage> | undefined) => {
              if (!old) return old;
              return applySessionUpdated(old, event.agent_session_id, updates);
            },
          );

          // store 동기화
          updateSession(event.agent_session_id, updates);

          // activeSessionSummary 동기화
          {
            const storeState = useDashboardStore.getState();
            if (event.agent_session_id === storeState.activeSessionKey) {
              const current = storeState.activeSessionSummary;
              if (current) {
                setActiveSessionSummary({ ...current, ...updates });
              } else {
                // ⚠️ URL 직접 진입 시 current가 null → 쿼리 캐시에서 bootstrap
                const allQueries = queryClient.getQueriesData<InfiniteData<SessionPage>>({ queryKey: ["sessions"], exact: false });
                for (const [, data] of allQueries) {
                  if (!data) continue;
                  for (const page of data.pages) {
                    const found = page.sessions.find((s) => s.agentSessionId === event.agent_session_id);
                    if (found) {
                      setActiveSessionSummary({ ...found, ...updates });
                      break;
                    }
                  }
                }
              }
            }
          }
          break;
        }

        case "session_deleted": {
          console.log(
            `[⚡ SSE] session_deleted → ${event.agent_session_id}`,
          );

          // TanStack Query 캐시 업데이트
          queryClient.setQueryData(
            queryKey,
            (old: InfiniteData<SessionPage> | undefined) => {
              if (!old) return old;
              return applySessionDeleted(old, event.agent_session_id);
            },
          );

          // store 동기화
          removeSession(event.agent_session_id);
          break;
        }

        case "catalog_updated":
          console.log(
            `[⚡ SSE] catalog_updated → folders=${event.catalog?.folders?.length}, sessions=${Object.keys(event.catalog?.sessions ?? {}).length}`,
          );
          useDashboardStore.getState().setCatalog(event.catalog);
          break;

        case "metadata_updated":
          // TanStack Query 캐시 업데이트
          queryClient.setQueryData(
            queryKey,
            (old: InfiniteData<SessionPage> | undefined) => {
              if (!old) return old;
              const newPages = old.pages.map((page) => ({
                ...page,
                sessions: page.sessions.map((s) =>
                  s.agentSessionId === event.session_id
                    ? { ...s, metadata: event.metadata }
                    : s,
                ),
              }));
              return { ...old, pages: newPages };
            },
          );

          // store 동기화
          updateSession(event.session_id, { metadata: event.metadata });
          break;
      }
    },
    [queryClient, queryKey, addSession, updateSession, removeSession, setActiveSessionSummary],
  );

  // --- SSE 연결 설정 ---
  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) return;

    const eventSource = new EventSource(
      `/api/sessions/stream?limit=${DEFAULT_PAGE_SIZE}`,
    );
    eventSourceRef.current = eventSource;

    let hadError = false;

    eventSource.onopen = () => {
      reconnectAttemptRef.current = 0;
      if (hadError) {
        queryRefetch();
      }
      hadError = false;
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
      hadError = true;
      if (eventSource.readyState === EventSource.CLOSED) {
        console.warn(
          "[SSE] EventSource CLOSED, reconnecting with backoff...",
        );
        eventSourceRef.current = null;
        const delay = Math.min(
          3000 * Math.pow(2, reconnectAttemptRef.current),
          30000,
        );
        reconnectAttemptRef.current++;
        if (reconnectTimerRef.current)
          clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          connectSSE();
        }, delay);
      }
    };
  }, [handleSSEEvent, queryRefetch]);

  // --- SSE 연결 해제 ---
  const disconnectSSE = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  // Effect: SSE 구독 — storageMode 변경 시에만 재연결
  useEffect(() => {
    if (!enabled || storageMode !== "sse" || externalProvider) return;

    connectSSE();

    return () => {
      disconnectSSE();
    };
  }, [enabled, storageMode, connectSSE, disconnectSSE, externalProvider]);

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
