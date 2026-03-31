/**
 * useSessionListProvider - Provider 기반 세션 목록 훅
 *
 * 현재 스토리지 모드에 따라 적절한 방식으로 세션 목록을 조회합니다:
 * - sse 모드: fetchSessions API 호출 + SSE delta 이벤트 (session_created/updated/deleted)
 * - serendipity 모드: 폴링 (5초 간격)
 *
 * 세션 타입 필터를 지원합니다. 가상 스크롤이 클라이언트 측 렌더링을 제어합니다.
 *
 * 설계 핵심:
 * - SSE 구독과 API fetch를 독립된 이펙트로 분리하여,
 *   필터 변경 시 SSE 연결이 끊어지지 않도록 합니다.
 * - SSE delta 이벤트는 전역이므로 storageMode 변경 시에만 재연결합니다.
 * - fetchSessions를 useRef로 래핑하여 useCallback 참조 변경이
 *   SSE 재연결이나 Effect 재실행을 유발하지 않도록 합니다.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { toSessionSummary } from "../shared/mappers";
import { SYSTEM_FOLDERS } from "../shared/constants";
import type { SessionStreamEvent, SessionStatus } from "../shared/types";
import type { SessionStorageProvider, StorageMode } from "../providers/types";

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
  const { intervalMs = 5000, enabled = true, getSessionProvider, externalProvider } = options;

  const storageMode = useDashboardStore((s) => s.storageMode);
  const setSessions = useDashboardStore((s) => s.setSessions);
  const appendSessions = useDashboardStore((s) => s.appendSessions);
  const addSession = useDashboardStore((s) => s.addSession);
  const updateSession = useDashboardStore((s) => s.updateSession);
  const removeSession = useDashboardStore((s) => s.removeSession);
  const setSessionsLoading = useDashboardStore((s) => s.setSessionsLoading);
  const setSessionsError = useDashboardStore((s) => s.setSessionsError);

  const sessions = useDashboardStore((s) => s.sessions);
  const sessionsTotal = useDashboardStore((s) => s.sessionsTotal);
  const loading = useDashboardStore((s) => s.sessionsLoading);
  const error = useDashboardStore((s) => s.sessionsError);

  // hasMore 계산 전용 구독 — loadMore는 getState()로 직접 접근
  const getSessionsInFolder = useDashboardStore((s) => s.getSessionsInFolder);

  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({});

  // 필터 상태
  const sessionTypeFilter = useDashboardStore((s) => s.sessionTypeFilter);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);

  // 첫 로드 추적 (최초 마운트 시에만 로딩 표시, 이후 페이지/필터 변경은 백그라운드 갱신)
  const isFirstLoad = useRef(true);
  const abortRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  /**
   * 세션 목록을 API로 조회합니다 (초기 로드 / 필터 변경 시).
   * offset=0부터 DEFAULT_PAGE_SIZE만큼 가져와 store를 교체합니다.
   */
  const fetchSessions = useCallback(async () => {
    // 최초 마운트 시에만 로딩 인디케이터 표시.
    // 페이지/필터 변경 시에는 백그라운드에서 데이터를 교체하여 깜빡임을 방지합니다.
    if (isFirstLoad.current) {
      setSessionsLoading(true);
    }

    try {
      abortRef.current = false;

      const provider = externalProvider ?? getSessionProvider(storageMode);
      const typeFilter = sessionTypeFilter === "all" ? undefined : sessionTypeFilter;
      // 폴더가 선택된 경우 folder_id를 전달하여 서버에서 필터링
      // stale closure 방지: viewMode와 selectedFolderId를 클로저가 아닌 store에서 직접 읽음
      const { viewMode: currentViewMode, selectedFolderId: currentFolderId } =
        useDashboardStore.getState();
      const folderFilter =
        currentViewMode === "folder" && currentFolderId !== null
          ? { folderId: currentFolderId }
          : {};
      const result = await provider.fetchSessions({
        sessionType: typeFilter,
        offset: 0,
        limit: DEFAULT_PAGE_SIZE,
        ...folderFilter,
      });

      if (abortRef.current) return;

      console.log(`[🔵 fetchSessions] 완료 → sessions=${result.sessions.length}, total=${result.total}`);
      setSessions(result.sessions, result.total);

      // 폴더별 세션 수 조회 (provider가 지원하는 경우)
      if (provider.fetchFolderCounts) {
        provider.fetchFolderCounts().then(setFolderCounts).catch(() => {});
      }
    } catch (err: unknown) {
      if (abortRef.current) return;

      const message =
        err instanceof Error ? err.message : "세션 목록 조회 실패";
      setSessionsError(message);
    } finally {
      isFirstLoad.current = false;
      setSessionsLoading(false);
    }
  }, [storageMode, sessionTypeFilter, setSessions, setSessionsLoading, setSessionsError, getSessionProvider, externalProvider]);

  // fetchSessions를 ref로 래핑하여, connectSSE와 Effect들의 의존성에서 분리.
  // useCallback 참조 변경이 SSE 재연결이나 Effect 재실행을 유발하지 않는다.
  const fetchSessionsRef = useRef(fetchSessions);
  fetchSessionsRef.current = fetchSessions;

  /**
   * 다음 페이지 세션을 추가 로드합니다.
   *
   * 현재 로드된 세션 수를 offset으로 사용하여 다음 페이지를 가져옵니다.
   * store의 sessions에 append합니다.
   */
  const loadMore = useCallback(async () => {
    const state = useDashboardStore.getState();
    const { sessionsTotal } = state;

    const isFolderView = viewMode === "folder" && selectedFolderId !== null;
    // SSE로 타 폴더 세션이 sessions에 추가될 수 있으므로 sessions.length가 아닌
    // getSessionsInFolder로 이 폴더에 실제 로드된 세션 수를 계산한다
    const offset = isFolderView
      ? state.getSessionsInFolder(selectedFolderId).length
      : state.sessions.length;

    if (offset >= sessionsTotal) return;

    try {
      const provider = externalProvider ?? getSessionProvider(storageMode);
      const typeFilter = sessionTypeFilter === "all" ? undefined : sessionTypeFilter;
      const result = await provider.fetchSessions({
        sessionType: typeFilter,
        offset,
        limit: DEFAULT_PAGE_SIZE,
        ...(isFolderView ? { folderId: selectedFolderId } : {}),
      });

      // race condition guard: 폴더 A → 폴더 B 전환 중 폴더 A의 loadMore가 완료된 경우 버림
      // 폴더 → 전체 뷰 전환은 fetchSessions의 setSessions가 최종 정정하므로 별도 가드 불필요
      if (isFolderView && useDashboardStore.getState().selectedFolderId !== selectedFolderId) return;

      appendSessions(result.sessions, result.total);
    } catch {
      // loadMore 실패는 조용히 무시 (다음 스크롤 시 재시도)
    }
  }, [storageMode, sessionTypeFilter, viewMode, selectedFolderId, appendSessions, getSessionProvider, externalProvider]);

  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // hasMore: 폴더 뷰에서는 폴더별 실제 로드 수 기준
  // (sessions.length는 SSE로 추가된 타 폴더 세션 포함으로 부정확)
  const hasMore = viewMode === "folder" && selectedFolderId !== null
    ? getSessionsInFolder(selectedFolderId).length < sessionsTotal
    : sessions.length < sessionsTotal;

  /**
   * SSE delta 이벤트 처리 (sse 모드)
   *
   * session_list는 무시하고, session_created/updated/deleted만 처리합니다.
   */
  const handleSSEEvent = useCallback(
    (event: SessionStreamEvent) => {
      setSessionsError(null);
      console.log(`[⚡ SSE] type=${event.type}`, event.type === "session_list" ? `(무시)` : "");
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
          updateSession(event.agent_session_id, updates);
          break;
        }

        case "session_deleted":
          console.log(`[⚡ SSE] session_deleted → ${event.agent_session_id}`);
          removeSession(event.agent_session_id);
          break;

        case "catalog_updated":
          console.log(`[⚡ SSE] catalog_updated → folders=${event.catalog?.folders?.length}, sessions=${Object.keys(event.catalog?.sessions ?? {}).length}`);
          useDashboardStore.getState().setCatalog(event.catalog);
          break;

        case "metadata_updated":
          updateSession(event.session_id, { metadata: event.metadata });
          break;
      }
    },
    [addSession, updateSession, removeSession, setSessionsError]
  );

  /**
   * SSE 연결 설정 (sse 모드 — delta 이벤트 수신용)
   *
   * EventSource 자동 재연결은 서버가 200 + text/event-stream으로 응답할 때만 동작합니다.
   * 서버가 완전히 다운되어 TCP 연결 자체가 실패하면 EventSource가 CLOSED(readyState=2)로
   * 전환되고, 이 경우 자동 재연결이 중단됩니다.
   * onerror에서 CLOSED 감지 시 exponential backoff (3s × 2^n, 최대 30초)로 재연결합니다.
   */
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);

  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) return;

    const eventSource = new EventSource(`/api/sessions/stream?limit=${DEFAULT_PAGE_SIZE}`);
    eventSourceRef.current = eventSource;

    // 재연결 감지: 에러 후 다시 연결되면 세션 목록을 다시 fetch
    let hadError = false;

    eventSource.onopen = () => {
      reconnectAttemptRef.current = 0; // 성공 시 backoff 카운터 리셋
      if (hadError) {
        // 페이지 리로드 대신 세션 목록만 다시 fetch (ref로 최신 참조 사용)
        fetchSessionsRef.current();
      }
      hadError = false;
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
      hadError = true;
      // EventSource가 CLOSED(readyState=2)되면 수동 재연결
      // (TCP 연결 실패, 비정상 상태 코드 등으로 자동 재연결이 중단된 경우)
      if (eventSource.readyState === EventSource.CLOSED) {
        console.warn("[SSE] EventSource CLOSED, reconnecting with backoff...");
        eventSourceRef.current = null;
        const delay = Math.min(3000 * Math.pow(2, reconnectAttemptRef.current), 30000);
        reconnectAttemptRef.current++;
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          connectSSE();
        }, delay);
      }
    };
  }, [handleSSEEvent, setSessionsError]); // fetchSessions 제거: ref로 접근

  /**
   * SSE 연결 해제
   */
  const disconnectSSE = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0; // 명시적 disconnect 시 카운터도 리셋
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  // Effect 1a: 초기 카탈로그 로드 — enabled 변경 시에만 실행 (viewMode/selectedFolderId 변경과 무관)
  // catalog fetch는 viewMode/selectedFolderId가 바뀔 때 재실행할 이유가 없으며,
  // 재실행되면 async 완료 시점에 selectFolder가 잘못 호출되는 race condition이 발생한다.
  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();

    fetch("/api/catalog", { signal: controller.signal })
      .then((r) => { if (r.ok) return r.json(); throw new Error("catalog fetch failed"); })
      .then((data) => {
        if (data?.folders && data?.sessions) {
          const store = useDashboardStore.getState();
          store.setCatalog(data);

          // selectedFolderId가 아직 설정되지 않았으면 기본 폴더 자동 선택
          // 피드 뷰에서는 자동 선택하지 않음 — viewMode를 "folder"로 강제 변경하지 않기 위함
          if (store.selectedFolderId === null && !store.activeSessionKey && store.viewMode !== "feed") {
            const claudeFolder = data.folders.find(
              (f: { name: string }) => f.name === SYSTEM_FOLDERS.claude,
            );
            const defaultFolderId = claudeFolder?.id ?? data.folders[0]?.id ?? null;
            if (defaultFolderId) {
              useDashboardStore.getState().selectFolder(defaultFolderId);
            }
          }
        }
      })
      .catch((err) => {
        // AbortError는 cleanup에 의한 정상 취소이므로 무시
        if (err instanceof DOMException && err.name === "AbortError") return;
      });

    return () => {
      controller.abort();
    };
  }, [enabled]); // viewMode/selectedFolderId 제거: catalog 로드는 마운트 시 1회만 필요

  // Effect 1b: fetchSessions — viewMode/selectedFolderId 변경 시 세션 재조회
  useEffect(() => {
    if (!enabled) return;

    fetchSessionsRef.current();

    return () => {
      abortRef.current = true;
    };
  }, [enabled, viewMode, selectedFolderId]); // fetchSessions 제거: ref로 접근

  // Effect 2: SSE 구독 — storageMode 변경 시에만 재연결 (페이지/필터 변경과 무관)
  useEffect(() => {
    if (!enabled || storageMode !== "sse" || externalProvider) return;

    connectSSE();

    return () => {
      disconnectSSE();
    };
  }, [enabled, storageMode, connectSSE, disconnectSSE, externalProvider]);

  // Effect 3: Serendipity 폴링 — storageMode가 serendipity일 때만 활성화
  useEffect(() => {
    if (!enabled || storageMode !== "serendipity" || externalProvider) return;

    const timer = setInterval(() => fetchSessionsRef.current(), intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [enabled, storageMode, intervalMs, externalProvider]); // fetchSessions 제거: ref 클로저로 접근

  // Effect 4: externalProvider 폴링 — externalProvider가 있을 때 intervalMs 간격으로 fetch
  useEffect(() => {
    if (!enabled || !externalProvider) return;

    const timer = setInterval(() => fetchSessionsRef.current(), intervalMs);

    return () => {
      clearInterval(timer);
    };
  }, [enabled, externalProvider, intervalMs]); // fetchSessions 제거: ref 클로저로 접근

  // storageMode 변경 시 첫 로드 플래그 리셋
  useEffect(() => {
    isFirstLoad.current = true;
  }, [storageMode]);

  return {
    sessions,
    sessionsTotal,
    loading,
    error,
    /** 추가 로드 가능 여부 */
    hasMore,
    /** 다음 페이지 세션 로드 */
    loadMore,
    /** 폴더별 세션 수 (서버 집계값, provider가 fetchFolderCounts를 지원하는 경우) */
    folderCounts,
    /** 수동 새로고침 */
    refetch: fetchSessions,
    storageMode,
  };
}
