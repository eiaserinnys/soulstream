import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { createApiClient } from '../api/client';
import { applySessionUpdated, toSession } from '../api/mappers';
import type {
  Catalog,
  CatalogSessionsDelta,
  Folder,
  Session,
} from '../api/types';
import { filterFeedSessions } from '../lib/feed-filter';
import { useSettingsStore } from '../store/settingsStore';
import { useSessionStore } from '../store/sessionStore';
import { useSSEStream, CATALOG_STREAM_EVENTS } from './useSSEStream';
import { plannerSourceForStreamEvent } from '../lib/planner-invalidation';
import { usePlannerStore } from '../store/plannerStore';
import { refreshCard } from '../store/cardStore';
import {
  captureAuthScope,
  isAuthScopeCurrent,
  useAuthScopeGeneration,
} from '../lib/auth-scope';

type CatalogUpdatedPayload = {
  catalog?: Catalog;
  folders?: Folder[];
  sessions_delta?: CatalogSessionsDelta;
};

type InitialDeltaEvent =
  | { type: 'session_created'; data: any }
  | { type: 'session_updated'; data: any }
  | { type: 'session_deleted'; data: any }
  | { type: 'catalog_updated'; data: CatalogUpdatedPayload };

type SessionListPayload = {
  sessions?: unknown[];
};

const FEED_CATALOG_PARAMS = { feed_only: true, limit: 0 } as const;
const FEED_CATALOG_STREAM_SCOPE = { feedOnly: true } as const;

function isCatalogSessionsDelta(value: unknown): value is CatalogSessionsDelta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((assignment) => {
    if (assignment === null) return true;
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) {
      return false;
    }
    const record = assignment as Record<string, unknown>;
    return (
      (record.folderId === null || typeof record.folderId === 'string')
      && (record.displayName === null || typeof record.displayName === 'string')
    );
  });
}

function sessionFromUpdate(
  agentSessionId: string,
  updates: Partial<Session>,
): Session | null {
  if (!updates.updatedAt) return null;
  return {
    agentSessionId,
    displayName: null,
    status: updates.status ?? 'unknown',
    reviewRequired: updates.reviewRequired ?? false,
    reviewState: updates.reviewState ?? 'not_required',
    createdAt: updates.updatedAt,
    updatedAt: updates.updatedAt,
    ...updates,
  };
}

function catalogWithSessionAssignments(
  catalog: Catalog,
  sessions: Session[],
): Catalog {
  const assignments = { ...catalog.sessions };
  for (const session of sessions) {
    if (!session.agentSessionId) continue;
    assignments[session.agentSessionId] = {
      folderId: session.folderId ?? null,
      displayName: session.displayName ?? null,
    };
  }
  return { folders: catalog.folders, sessions: assignments };
}

function filteredFeedSnapshot(sessions: Session[], catalog: Catalog): Session[] {
  return filterFeedSessions(sessions, catalog);
}

/**
 * TabNavigator 최상위에서 마운트.
 * RootNavigator가 serverUrl 있을 때만 TabNavigator를 렌더링하므로
 * 항상 serverUrl이 존재하는 컨텍스트에서 실행됨.
 *
 * 정본 분리:
 * - 초기 상태는 `/api/folders`와 `/api/sessions`에서 책임별로 받는다.
 *   응답의 `folders`, `sessions`(폴더 배정 맵), `sessionList`(camelCase, Phase A-bis 2026-05-16)을
 *   각각 setFeedCatalogSnapshot과 mergeSessions에 동시에 흘려 정본을 분산시키지 않는다.
 * - SSE(`/api/sessions/stream`)는 그 이후의 델타(session_created/updated/deleted,
 *   catalog_updated, metadata_updated)만 처리한다.
 *
 * Wire 정규화 정본은 `api/mappers.ts`의 toSession / applySessionUpdated 한 곳.
 * orch wire가 3변형(REST sessionList camelCase + SSE session_created.session MIXED
 * + SSE session_updated MIXED)이라도 mapper에 흘려보내면 항상 camelCase Session으로 통일된다.
 *
 * 대시보드(packages/soul-ui)도 동일하게 REST = 초기 / SSE = 델타 패턴을 사용한다 —
 * `useSessionListProvider` + `useSessionStreamCacheSync` + `shared/mappers.ts` 조합 참조.
 *
 * Phase 3 (catalog-sse-replay): Last-Event-ID 기반 resume + replay_gap 폴백.
 * - lastEventIdRef: SSE id가 부착된 이벤트 수신 시 갱신. 다음 connect 시 ?lastEventId=로 부착.
 * - instanceIdRef: 첫 stream_meta에서 저장. 이후 stream_meta에서 instance_id가 바뀌면 서버
 *   재시작·인스턴스 교체로 간주하여 풀 재페치 + lastEventId 점프.
 * - replay_gap: 서버 ring buffer 부족 신호. 풀 재페치 + lastEventId 점프(loss 감수).
 */
export function useSessionsStream() {
  const serverUrl = useSettingsStore((s) => s.serverUrl);
  const scopeGeneration = useAuthScopeGeneration();
  const catalogRetryRequest = useSessionStore((state) => state.catalogRetryRequest);
  const scope = useMemo(() => captureAuthScope(), [scopeGeneration]);

  const api = useMemo(
    () => (serverUrl ? createApiClient(serverUrl, { authScope: scope }) : null),
    [scope, serverUrl]
  );

  // SSE id가 부착된 이벤트 수신 시 갱신. 매 SSE connect/reconnect 시 urlBuilder가
  // 최신값을 ?lastEventId=N으로 부착하여 서버가 그 이후 이벤트만 replay하도록 한다.
  const lastEventIdRef = useRef<string | undefined>(undefined);
  // 서버 인스턴스 식별 — 첫 stream_meta에서 저장. 인스턴스 교체 감지의 단일 정본.
  const instanceIdRef = useRef<string | undefined>(undefined);
  // gap refetch 단조 증가 토큰 — replay_gap·instance 교체가 빠르게 연달아 들어올 때
  // stale 응답이 최신 응답을 덮어쓰는 race를 차단한다. 매 호출 시 ++가 myToken을 증가시키고,
  // 응답 도착 시 자기 토큰이 최신이 아니면 silent drop.
  const refetchTokenRef = useRef(0);
  const initialCatalogReadyRef = useRef(false);
  const initialCatalogFailedRef = useRef(false);
  // initial REST snapshot과 SSE delta의 병합 규칙:
  // snapshot 요청이 pending인 동안 들어온 delta는 즉시 적용하되, snapshot 적용 직후
  // 같은 순서로 한 번 더 replay한다. 따라서 stale snapshot은 "초기 base" 역할만 하고,
  // 클라이언트가 이미 관측한 SSE incremental update가 최종 승자가 된다.
  const initialCatalogPendingRef = useRef(false);
  const pendingInitialDeltaEventsRef = useRef<InitialDeltaEvent[]>([]);
  const pendingSessionListRef = useRef<SessionListPayload | null>(null);
  const refsOwnerRef = useRef(scope.generation);

  if (refsOwnerRef.current !== scope.generation) {
    refsOwnerRef.current = scope.generation;
    lastEventIdRef.current = undefined;
    instanceIdRef.current = undefined;
    refetchTokenRef.current += 1;
    initialCatalogReadyRef.current = false;
    initialCatalogFailedRef.current = false;
    initialCatalogPendingRef.current = false;
    pendingInitialDeltaEventsRef.current = [];
    pendingSessionListRef.current = null;
  }

  const isCurrentScope = useCallback(
    () => isAuthScopeCurrent(scope),
    [scope],
  );

  const applySessionListFallback = useCallback((d: SessionListPayload) => {
    if (!isCurrentScope()) return;
    const rawSessions = Array.isArray(d?.sessions) ? d.sessions : [];
    const sessions = rawSessions
      .map((raw: unknown) => toSession(raw as Record<string, unknown>))
      .filter((session: Session) => !!session.agentSessionId);
    const store = useSessionStore.getState();
    const catalog = catalogWithSessionAssignments(store.catalog, sessions);
    store.setFeedCatalogSnapshot(catalog);
    store.mergeSessions(filteredFeedSnapshot(sessions, catalog));
    initialCatalogReadyRef.current = true;
    initialCatalogFailedRef.current = false;
    pendingSessionListRef.current = null;
  }, [isCurrentScope]);

  const applyCatalogDeltaEvent = useCallback((type: InitialDeltaEvent['type'], d: any) => {
    if (!isCurrentScope()) return;
    switch (type) {
      case 'session_created': {
        // orch wire(_on_node_change): { type, session: <to_session_info MIXED>, nodeId, folder_id? }
        // mapper로 정규화하여 store에 upsert.
        const raw = d?.session as Record<string, unknown> | undefined;
        if (raw) {
          const session = toSession(raw);
          if (session.agentSessionId) {
            useSessionStore.getState().upsertSession(session);
          }
        }
        break;
      }
      case 'session_updated': {
        // orch wire: { type, agent_session_id, agentSessionId?, status, updated_at, ... , nodeId }
        // 식별자는 snake/camel 양쪽 모두 시도.
        const sid =
          (d?.agentSessionId as string | undefined) ??
          (d?.agent_session_id as string | undefined);
        if (typeof sid !== 'string' || !sid) break;
        const updates = applySessionUpdated(d as Record<string, unknown>);
        const store = useSessionStore.getState();
        if (store.sessions[sid]) {
          store.updateSession(sid, updates);
        } else {
          const carriesLastMessage =
            Object.prototype.hasOwnProperty.call(d, 'lastMessage')
            || Object.prototype.hasOwnProperty.call(d, 'last_message');
          // 새 entry는 보존할 이전 preview가 없다. invalid/null message delta의 updatedAt만으로
          // phantom session을 만들면 raw event가 피드에 승격되므로 snapshot을 기다린다.
          if (carriesLastMessage && !updates.lastMessage) break;
          const session = sessionFromUpdate(sid, updates);
          if (session) store.upsertSession(session);
        }
        const attentionDelta = d?.pendingAttentionsDelta
          ?? d?.pending_attentions_delta;
        const updatedStore = useSessionStore.getState();
        if (attentionDelta !== undefined && updatedStore.sessions[sid]) {
          updatedStore.applyPendingAttentionsDelta(
            sid,
            attentionDelta,
            d?.attentionRevision ?? d?.attention_revision,
          );
        }
        break;
      }
      case 'session_deleted': {
        // 서버 emit 실측: { type, agent_session_id }
        const sid =
          (d?.agentSessionId as string | undefined) ??
          (d?.agent_session_id as string | undefined);
        if (sid) useSessionStore.getState().deleteSession(sid);
        break;
      }
      case 'catalog_updated': {
        const payload = d as CatalogUpdatedPayload;
        const store = useSessionStore.getState();
        // expand 단계: 구형 전체 snapshot과 신형 세션 델타를 함께 소비한다.
        if (payload.catalog) {
          store.setFeedCatalogSnapshot(payload.catalog);
        } else if (
          Array.isArray(payload.folders)
          && isCatalogSessionsDelta(payload.sessions_delta)
        ) {
          store.applyCatalogDelta(payload.folders, payload.sessions_delta);
        }
        break;
      }
    }
  }, [isCurrentScope]);

  const applyAndBufferInitialDelta = useCallback(
    (event: InitialDeltaEvent) => {
      if (initialCatalogPendingRef.current) {
        pendingInitialDeltaEventsRef.current.push(event);
      }
      applyCatalogDeltaEvent(event.type, event.data);
    },
    [applyCatalogDeltaEvent],
  );

  // 마운트(또는 명시 재시도/serverUrl 변경) 시 초기 상태를 folders/sessions로 페치한다.
  // REST가 실패해도 SSE session_list가 있으면 snapshot fallback을 적용한다. 둘 다 없으면
  // empty와 구분되는 오류 상태로 전환해 사용자가 다시 시도할 수 있게 한다.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const controller = new AbortController();
    initialCatalogPendingRef.current = true;
    pendingInitialDeltaEventsRef.current = [];

    api
      .getCatalog(FEED_CATALOG_PARAMS, { signal: controller.signal })
      .then((cat) => {
        if (cancelled || !isCurrentScope()) return;
        const { setFeedCatalogSnapshot, mergeSessions } = useSessionStore.getState();
        // getCatalog 조립 응답: { folders, sessions, sessionList, total }
        // - folders + sessions(폴더 배정 맵) → setFeedCatalogSnapshot
        // - sessionList (camelCase, Phase A-bis) → mapper로 정규화 후 mergeSessions
        const catalog = { folders: cat.folders, sessions: cat.sessions };
        setFeedCatalogSnapshot(catalog);
        if (Array.isArray(cat.sessionList)) {
          // feed_only snapshot은 피드 projection이다. 인증 scope reset 뒤에는 store 자체가 이미
          // 비어 있으므로 merge로 채워도 되고, 재시도 중 열린 상세 cache를 삭제하지 않는다.
          const list = cat.sessionList.map((raw) =>
            toSession(raw as unknown as Record<string, unknown>),
          );
          mergeSessions(filteredFeedSnapshot(list, catalog));
        }
        const pending = pendingInitialDeltaEventsRef.current;
        pendingInitialDeltaEventsRef.current = [];
        initialCatalogPendingRef.current = false;
        for (const event of pending) {
          applyCatalogDeltaEvent(event.type, event.data);
        }
        initialCatalogReadyRef.current = true;
        initialCatalogFailedRef.current = false;
        pendingSessionListRef.current = null;
      })
      .catch((err) => {
        if (cancelled || !isCurrentScope()) return;
        initialCatalogPendingRef.current = false;
        initialCatalogReadyRef.current = false;
        initialCatalogFailedRef.current = true;
        pendingInitialDeltaEventsRef.current = [];
        const pendingSessionList = pendingSessionListRef.current;
        if (pendingSessionList) {
          applySessionListFallback(pendingSessionList);
        } else if (!useSessionStore.getState().catalogReady) {
          useSessionStore.getState().markCatalogLoadFailed();
        }
        console.warn('[useSessionsStream] initial catalog fetch failed:', err);
      });

    return () => {
      cancelled = true;
      controller.abort();
      initialCatalogPendingRef.current = false;
      initialCatalogReadyRef.current = false;
      initialCatalogFailedRef.current = false;
      pendingInitialDeltaEventsRef.current = [];
      pendingSessionListRef.current = null;
    };
  }, [
    api,
    applyCatalogDeltaEvent,
    applySessionListFallback,
    catalogRetryRequest,
    isCurrentScope,
  ]);

  // gap 시 명시적 폴백 — 서버가 replay_gap 또는 instance 교체를 신호한 경우만.
  // (임시 우회 아닌 명시적 신호에 따른 풀 재페치이므로 design-principles §3 위배 아님)
  //
  // setSessions(전체 덮어쓰기) 대신 mergeSessions를 사용한다.
  // 이유: 다른 화면이 글로벌 useSessionStore.sessions에 의존하는 룩업·필터링 경로가 있다.
  //   - SessionFeedScreen: feedSessionIds를 정렬·필터 정본으로 삼아 카드 id를 표시
  //   - ChatScreen·ChatBody·ChatPane 헤더: sessions[agentSessionId]에서 displayName·status 룩업
  //   (FolderContentsScreen·MainListPane 폴더 분기는 Phase 1에서 useFolderPagination으로
  //    표시 정본을 분리했으므로 이 변경 없이도 회귀 면역.)
  // 이들 entry를 setSessions로 통째 갈아엎으면 gap 직후 정상 entry가 한순간 사라진다.
  // feed_only catalog.sessions는 피드에 남을 assignment만 담는 scoped projection이다.
  // 따라서 이 snapshot은 setFeedCatalogSnapshot으로 피드 membership만 reconcile해야 한다. 그 keys 집합으로
  // global sessions cache를 지우면 visible → excluded 전환 뒤 열린 상세까지 삭제된다.
  // 실제 삭제는 session_deleted, 상세 접근 상실은 detail history의 403/404 계약이 정리한다.
  const refetchCatalogOnGap = useCallback(() => {
    if (!api) return;
    const myToken = ++refetchTokenRef.current;
    api
      .getCatalog(FEED_CATALOG_PARAMS)
      .then((cat) => {
        // 더 새로운 호출이 시작됐다면 이 응답은 stale — drop.
        // (race: gap A → fetch1, gap B → fetch2, fetch2 도착, fetch1 도착이면 fetch1을 무시)
        if (myToken !== refetchTokenRef.current || !isCurrentScope()) return;
        const { setFeedCatalogSnapshot, mergeSessions } = useSessionStore.getState();
        const catalog = { folders: cat.folders, sessions: cat.sessions };
        setFeedCatalogSnapshot(catalog);
        if (Array.isArray(cat.sessionList)) {
          const list = cat.sessionList.map((raw) =>
            toSession(raw as unknown as Record<string, unknown>),
          );
          mergeSessions(filteredFeedSnapshot(list, catalog));
        }
      })
      .catch((err) => {
        if (myToken !== refetchTokenRef.current || !isCurrentScope()) return;
        console.warn('[useSessionsStream] gap refetch failed:', err);
      });
  }, [api, isCurrentScope]);

  // background를 거쳤다가 active로 돌아올 때 catalog를 능동 refetch한다.
  // useSSEStream의 AppState 게이트가 SSE 자체는 reconnect시키지만, long-background로
  // 서버 ring buffer가 lastEventId를 넘어 advanced된 경우 ?lastEventId= resume이 실패한다.
  // 서버의 replay_gap 신호를 기다리는 대신 클라이언트가 능동적으로 풀 동기화하여
  // status stale을 즉시 해소한다 (refetchTokenRef 재사용으로 race-safe).
  //
  // refetchCatalogOnGap은 api === null이면 silent return. 호출 전 별도 가드 불필요 —
  // serverUrl 미설정 상태에서는 SSE 자체가 enabled=false라 stale 갱신 대상도 없다.
  //
  // 게이트 정책은 useSSEStream과 동일 — wasBackgrounded 플래그 + destroyed 가드.
  // destroyed 가드는 unmount 후 큐잉된 AppState 콜백이 발화해 불필요한 초기 fetch
  // 요청이 나가는 것을 차단한다 (refetchTokenRef는 응답을 drop하지만 요청 자체는 차단 못함).
  useEffect(() => {
    let destroyed = false;
    let wasBackgrounded = false;
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (destroyed) return;
      if (next === 'background') {
        wasBackgrounded = true;
        return;
      }
      if (next === 'active' && wasBackgrounded) {
        wasBackgrounded = false;
        refetchCatalogOnGap();
      }
    });
    return () => {
      destroyed = true;
      sub.remove();
    };
  }, [refetchCatalogOnGap]);

  useSSEStream({
    diagnosticsSource: 'feed_stream',
    urlBuilder: () =>
      api
        ? api.catalogStreamUrl(
            lastEventIdRef.current,
            instanceIdRef.current,
            FEED_CATALOG_STREAM_SCOPE,
          )
        : '',
    eventTypes: [...CATALOG_STREAM_EVENTS],
    enabled: !!api,
    connectionKey: `catalog-retry:${catalogRetryRequest}`,
    scopeGeneration: scope.generation,
    onEvent: (type, data, eid) => {
      if (!isCurrentScope()) return;
      const d = data as any;
      switch (type) {
        case 'stream_meta': {
          const newInstanceId = d?.instance_id as string | undefined;
          if (!newInstanceId) break;
          // 첫 stream_meta(빈 ref): instanceIdRef만 저장하고 lastEventIdRef는 점프하지 않는다
          // — 이미 받은 lastEventId 좌표가 유효하다면 서버가 그 이후 이벤트를 replay해 준다.
          // 두 번째 이상에서 instance_id 변경 감지 시: 서버 재시작 → 풀 재페치 + 점프.
          if (instanceIdRef.current && instanceIdRef.current !== newInstanceId) {
            refetchCatalogOnGap();
            usePlannerStore.getState().invalidate('replay');
            lastEventIdRef.current = String(d.latest_id ?? 0);
          }
          instanceIdRef.current = newInstanceId;
          break;
        }
        case 'replay_gap': {
          // 서버 ring buffer 부족 — 일부 이벤트 손실. 풀 재페치로 정본 동기화 후
          // 좌표를 latest_id로 점프 (이후 델타만 받음).
          refetchCatalogOnGap();
          lastEventIdRef.current = String(d?.latest_id ?? 0);
          break;
        }
        case 'session_list':
          // 정상 경로의 정본은 REST snapshot이다. 단, 초기 REST가 실패한 경우에는
          // SSE session_list를 일회성 fallback snapshot으로 사용해 빈 피드 고착을 막는다.
          if (initialCatalogReadyRef.current) {
            break;
          }
          if (initialCatalogPendingRef.current) {
            pendingSessionListRef.current = d as SessionListPayload;
            break;
          }
          if (initialCatalogFailedRef.current) {
            applySessionListFallback(d as SessionListPayload);
          }
          break;
        case 'session_created': {
          applyAndBufferInitialDelta({ type, data: d });
          break;
        }
        case 'session_updated': {
          applyAndBufferInitialDelta({ type, data: d });
          break;
        }
        case 'session_deleted': {
          applyAndBufferInitialDelta({ type, data: d });
          break;
        }
        case 'catalog_updated':
          applyAndBufferInitialDelta({ type, data: d });
          break;
        case 'card_updated':
          if (api && typeof d?.cardId === 'string') {
            void refreshCard(api, d.cardId).catch((error) => {
              console.warn('[cards] card refresh failed', error);
            });
          }
          break;
        case 'folder_updated':
          refetchCatalogOnGap();
          break;
      }
      const plannerSource = plannerSourceForStreamEvent(type);
      if (plannerSource) {
        usePlannerStore.getState().invalidate(plannerSource);
      }
      // Store와 planner side effect가 모두 commit된 뒤에만 resume cursor를 확정한다.
      // 그 전에 mutation이 throw하면 useSSEStream이 연결을 닫고 이전 cursor로
      // 재연결하여 이 event를 replay한다. stream_meta/session_list/replay_gap에는
      // 서버 합의상 SSE id가 없다.
      if (eid) lastEventIdRef.current = eid;
    },
    onError: (err) => {
      if (!isCurrentScope()) return;
      console.warn('[useSessionsStream] SSE error:', err);
    },
  });
}
