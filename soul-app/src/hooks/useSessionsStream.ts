import { useCallback, useEffect, useMemo, useRef } from 'react';
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
  const assignments: Catalog['sessions'] = {};
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

/** Feed-scoped catalog replay. REST is used for hydration and explicit replay gaps. */
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
  const refetchTokenRef = useRef(0);
  const consumerFailureRef = useRef<(error: unknown) => void>(() => {});
  const recoveryRef = useRef<{
    token: number;
    boundary?: string;
    instanceId?: string;
    events: Array<{ type: string; data: any; eid?: string }>;
  } | null>(null);
  const cursorlessSnapshotRef = useRef<{ instanceId?: string } | null>(null);
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
    recoveryRef.current = null;
    cursorlessSnapshotRef.current = null;
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

  const applySnapshot = useCallback((cat: Catalog & { sessionList?: unknown[] }) => {
    const store = useSessionStore.getState();
    const catalog = { folders: cat.folders, sessions: cat.sessions };
    // Scoped feed membership is authoritative, while open detail caches survive.
    store.setFeedCatalogSnapshot(catalog);
    if (Array.isArray(cat.sessionList)) {
      const list = cat.sessionList.map(raw => toSession(raw as Record<string, unknown>));
      store.mergeSessions(filteredFeedSnapshot(list, catalog));
    }
  }, []);

  // 마운트(또는 명시 재시도/serverUrl 변경) 시 초기 상태를 folders/sessions로 페치한다.
  // REST가 실패해도 SSE session_list가 있으면 snapshot fallback을 적용한다. 둘 다 없으면
  // empty와 구분되는 오류 상태로 전환해 사용자가 다시 시도할 수 있게 한다.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const myToken = ++refetchTokenRef.current;
    const controller = new AbortController();
    initialCatalogPendingRef.current = true;
    pendingInitialDeltaEventsRef.current = [];

    api
      .getCatalog(FEED_CATALOG_PARAMS, { signal: controller.signal })
      .then((cat) => {
        if (cancelled || myToken !== refetchTokenRef.current || !isCurrentScope()) return;
        applySnapshot(cat);
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
        if (cancelled || myToken !== refetchTokenRef.current || !isCurrentScope()) return;
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
      refetchTokenRef.current += 1;
      recoveryRef.current = null;
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
    applySnapshot,
    catalogRetryRequest,
    isCurrentScope,
  ]);

  const applyStreamEvent = useCallback((type: string, d: any) => {
    switch (type) {
      case 'session_created':
      case 'session_updated':
      case 'session_deleted':
      case 'catalog_updated':
        applyAndBufferInitialDelta({ type, data: d });
        break;
      case 'session_list':
        // A reconnect before the first durable ID is a fresh server connection.
        // Consume its snapshot; metadata alone still cannot advance the cursor.
        if (cursorlessSnapshotRef.current) {
          applySessionListFallback(d);
          if (cursorlessSnapshotRef.current.instanceId) {
            instanceIdRef.current = cursorlessSnapshotRef.current.instanceId;
          }
          cursorlessSnapshotRef.current = null;
          usePlannerStore.getState().invalidate('replay');
          break;
        }
        if (initialCatalogReadyRef.current) break;
        if (initialCatalogPendingRef.current) pendingSessionListRef.current = d;
        else if (initialCatalogFailedRef.current) applySessionListFallback(d);
        break;
      case 'card_updated':
        if (api && typeof d?.cardId === 'string') {
          void refreshCard(api, d.cardId).catch(error => {
            console.warn('[cards] card refresh failed', error);
          });
        }
        break;
    }
    const plannerSource = plannerSourceForStreamEvent(type);
    if (plannerSource) usePlannerStore.getState().invalidate(plannerSource);
  }, [api, applyAndBufferInitialDelta, applySessionListFallback]);

  const refetchCatalog = useCallback((boundary?: string, instanceId?: string, force = false) => {
    if (!api) return;
    const previous = recoveryRef.current;
    if (!force && previous && previous.boundary === boundary && previous.instanceId === instanceId) return;
    const recovery = {
      token: ++refetchTokenRef.current,
      boundary,
      instanceId,
      events: previous?.events ?? [],
    };
    recoveryRef.current = recovery;
    // An explicit recovery supersedes an older hydration response.
    initialCatalogPendingRef.current = false;
    pendingInitialDeltaEventsRef.current = [];
    api.getCatalog(FEED_CATALOG_PARAMS).then(cat => {
      if (recovery.token !== refetchTokenRef.current || !isCurrentScope()) return;
      applySnapshot(cat);
      let committedId = recovery.boundary ?? lastEventIdRef.current;
      for (const event of recovery.events) {
        // latest_id is a catalog coordinate, never a per-session event ID.
        if (event.eid && recovery.boundary !== undefined
          && Number(event.eid) <= Number(recovery.boundary)) continue;
        applyStreamEvent(event.type, event.data);
        if (event.eid) committedId = event.eid;
      }
      usePlannerStore.getState().invalidate('replay');
      initialCatalogReadyRef.current = true;
      initialCatalogFailedRef.current = false;
      pendingSessionListRef.current = null;
      // Commit cursor/instance only once snapshot and ordered tail have succeeded.
      lastEventIdRef.current = committedId;
      if (recovery.instanceId) instanceIdRef.current = recovery.instanceId;
      recoveryRef.current = null;
    }).catch(error => {
      if (recovery.token !== refetchTokenRef.current || !isCurrentScope()) return;
      recoveryRef.current = null;
      initialCatalogFailedRef.current = !initialCatalogReadyRef.current;
      consumerFailureRef.current(error);
    });
  }, [api, applySnapshot, applyStreamEvent, isCurrentScope]);

  const cancelRecovery = useCallback(() => {
    if (!recoveryRef.current) return;
    refetchTokenRef.current += 1;
    recoveryRef.current = null;
  }, []);

  useSSEStream({
    diagnosticsSource: 'feed_stream',
    consumerFailureRef,
    onConnecting: () => {
      cancelRecovery();
      cursorlessSnapshotRef.current = initialCatalogReadyRef.current
        && lastEventIdRef.current === undefined ? {} : null;
    },
    onSuspending: cancelRecovery,
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
      if (type === 'stream_meta') {
        // With a committed cursor, the route emits replay_gap for mismatches.
        // Metadata alone must not commit a new coordinate or start a second REST.
        if (cursorlessSnapshotRef.current) cursorlessSnapshotRef.current.instanceId = d?.instance_id;
        else if (!instanceIdRef.current && d?.instance_id) instanceIdRef.current = d.instance_id;
        return;
      }
      if (type === 'replay_gap') {
        refetchCatalog(String(d?.latest_id ?? 0), d?.instance_id ?? instanceIdRef.current);
        return;
      }
      const recovery = recoveryRef.current;
      if (recovery) {
        recovery.events.push({ type, data: d, eid });
        if (type === 'folder_updated') refetchCatalog(recovery.boundary, recovery.instanceId, true);
        return;
      }
      if (type === 'folder_updated') {
        refetchCatalog();
        recoveryRef.current?.events.push({ type, data: d, eid });
        return;
      }
      applyStreamEvent(type, d);
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
