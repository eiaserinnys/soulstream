import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createApiClient } from '../api/client';
import { applySessionUpdated, toSession } from '../api/mappers';
import type { Catalog, CatalogSessionsDelta, Folder, Session } from '../api/types';
import {
  applyPendingAttentionDelta,
  createPendingAttentionVersionState,
} from '../lib/session-attention';
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
import { FEED_PAGE_SIZE } from '../api/feedPage';

type CatalogUpdatedPayload = {
  catalog?: Catalog;
  folders?: Folder[];
  sessions_delta?: CatalogSessionsDelta;
};

type StreamMeta = {
  latestId: string;
  instanceId: string;
};

type PendingAttentionDelta = {
  delta: unknown;
  revision: unknown;
};

type InFlightSession = {
  controller: AbortController;
  pendingUpdates: Partial<Session>;
  pendingAttention: PendingAttentionDelta[];
};

const FEED_CATALOG_STREAM_SCOPE = {
  feedOnly: true,
  feedDisplay: true,
  limit: FEED_PAGE_SIZE,
} as const;

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

function readStreamMeta(value: unknown): StreamMeta {
  if (!value || typeof value !== 'object') throw new Error('Invalid catalog stream metadata');
  const record = value as Record<string, unknown>;
  const latestId = record.latest_id;
  if (
    (typeof latestId !== 'string' && typeof latestId !== 'number')
    || typeof record.instance_id !== 'string'
  ) {
    throw new Error('Invalid catalog stream metadata');
  }
  return { latestId: String(latestId), instanceId: record.instance_id };
}

function readSessionList(value: unknown): {
  folders: Folder[];
  sessions: Session[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
} {
  if (!value || typeof value !== 'object') throw new Error('Invalid feed session snapshot');
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.folders)
    || !Array.isArray(record.sessions)
    || typeof record.total !== 'number'
    || typeof record.hasMore !== 'boolean'
    || !(record.nextCursor === null || typeof record.nextCursor === 'string')
  ) {
    throw new Error('Invalid feed session snapshot');
  }
  const sessions = record.sessions.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('Invalid feed session row');
    }
    const session = toSession(row as Record<string, unknown>);
    if (!session.agentSessionId) throw new Error('Feed session row has no id');
    return session;
  });
  return {
    folders: record.folders as Folder[],
    sessions,
    total: record.total,
    hasMore: record.hasMore,
    nextCursor: record.nextCursor as string | null,
  };
}

function attentionDeltaFrom(data: Record<string, unknown>): PendingAttentionDelta | null {
  const delta = data.pendingAttentionsDelta ?? data.pending_attentions_delta;
  if (delta === undefined) return null;
  return {
    delta,
    revision: data.attentionRevision ?? data.attention_revision,
  };
}

function patchNeedsFeedHydration(
  sessionId: string,
  updates: Partial<Session>,
  attention: PendingAttentionDelta | null,
): boolean {
  if (updates.status === 'running' || updates.reviewState === 'needs_review') return true;
  if (!attention) return false;
  const result = applyPendingAttentionDelta(
    [],
    0,
    createPendingAttentionVersionState(0),
    sessionId,
    attention.delta,
    attention.revision,
  );
  return result.pendingAttentions.length > 0;
}

/** Feed snapshot and live catalog deltas share one stream; REST is reserved for one row/page. */
export function useSessionsStream() {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const scopeGeneration = useAuthScopeGeneration();
  const catalogRetryRequest = useSessionStore((state) => state.catalogRetryRequest);
  const scope = useMemo(() => captureAuthScope(), [scopeGeneration]);
  const api = useMemo(
    () => serverUrl ? createApiClient(serverUrl, { authScope: scope }) : null,
    [scope, serverUrl],
  );

  const lastEventIdRef = useRef<string | undefined>(undefined);
  const instanceIdRef = useRef<string | undefined>(undefined);
  const streamMetaRef = useRef<StreamMeta | null>(null);
  const inFlightSessionsRef = useRef(new Map<string, InFlightSession>());
  const refsOwnerRef = useRef(scope.generation);

  const abortHydration = useCallback((sessionId: string) => {
    const pending = inFlightSessionsRef.current.get(sessionId);
    if (!pending) return;
    pending.controller.abort();
    inFlightSessionsRef.current.delete(sessionId);
  }, []);

  const abortAllHydrations = useCallback(() => {
    for (const pending of inFlightSessionsRef.current.values()) pending.controller.abort();
    inFlightSessionsRef.current.clear();
  }, []);

  if (refsOwnerRef.current !== scope.generation) {
    abortAllHydrations();
    refsOwnerRef.current = scope.generation;
    lastEventIdRef.current = undefined;
    instanceIdRef.current = undefined;
    streamMetaRef.current = null;
  }

  useEffect(() => abortAllHydrations, [abortAllHydrations, scopeGeneration]);

  const isCurrentScope = useCallback(
    () => isAuthScopeCurrent(scope),
    [scope],
  );

  const hydrateSession = useCallback((
    sessionId: string,
    updates: Partial<Session>,
    attention: PendingAttentionDelta | null,
  ) => {
    if (!api || !isCurrentScope()) return;
    const current = inFlightSessionsRef.current.get(sessionId);
    if (current) {
      current.pendingUpdates = { ...current.pendingUpdates, ...updates };
      if (attention) current.pendingAttention.push(attention);
      return;
    }

    const pending: InFlightSession = {
      controller: new AbortController(),
      pendingUpdates: updates,
      pendingAttention: attention ? [attention] : [],
    };
    inFlightSessionsRef.current.set(sessionId, pending);
    void api.getSessionsByIds([sessionId], pending.controller.signal)
      .then((rows) => {
        if (
          pending.controller.signal.aborted
          || inFlightSessionsRef.current.get(sessionId) !== pending
          || !isCurrentScope()
        ) return;
        const row = rows.find((candidate) => candidate.agentSessionId === sessionId);
        if (!row) return;
        const store = useSessionStore.getState();
        store.upsertSession(row, { feedEvent: true });
        const latestStore = useSessionStore.getState();
        if (Object.keys(pending.pendingUpdates).length > 0) {
          latestStore.updateSession(sessionId, pending.pendingUpdates);
        }
        for (const delta of pending.pendingAttention) {
          useSessionStore.getState().applyPendingAttentionsDelta(
            sessionId,
            delta.delta,
            delta.revision,
          );
        }
      })
      .catch((error) => {
        if (!pending.controller.signal.aborted && isCurrentScope()) {
          console.warn('[useSessionsStream] session hydration failed:', error);
        }
      })
      .finally(() => {
        if (inFlightSessionsRef.current.get(sessionId) === pending) {
          inFlightSessionsRef.current.delete(sessionId);
        }
      });
  }, [api, isCurrentScope]);

  const applySessionUpdated = useCallback((data: Record<string, unknown>) => {
    const sessionId = (data.agentSessionId ?? data.agent_session_id) as string | undefined;
    if (typeof sessionId !== 'string' || !sessionId) return;
    const updates = applySessionUpdatedPayload(data);
    const attention = attentionDeltaFrom(data);
    const store = useSessionStore.getState();
    const membership = store.feedMembership[sessionId];

    if (store.sessions[sessionId]) {
      store.updateSession(sessionId, updates);
      if (attention) {
        useSessionStore.getState().applyPendingAttentionsDelta(
          sessionId,
          attention.delta,
          attention.revision,
        );
      }
    }

    if (inFlightSessionsRef.current.has(sessionId)) {
      hydrateSession(sessionId, updates, attention);
      return;
    }

    if (membership !== undefined) return;
    if (patchNeedsFeedHydration(sessionId, updates, attention)) {
      hydrateSession(sessionId, updates, attention);
    }
  }, [hydrateSession]);

  const applyCatalogEvent = useCallback((type: string, data: any) => {
    if (!isCurrentScope()) return;
    switch (type) {
      case 'session_created': {
        const raw = data?.session as Record<string, unknown> | undefined;
        if (raw) {
          const row = toSession(raw);
          if (row.agentSessionId) {
            useSessionStore.getState().upsertSession(row, { feedEvent: true });
          }
        }
        break;
      }
      case 'session_updated':
        applySessionUpdated(data ?? {});
        break;
      case 'session_deleted': {
        const sessionId = (data?.agentSessionId ?? data?.agent_session_id) as string | undefined;
        if (sessionId) {
          abortHydration(sessionId);
          useSessionStore.getState().deleteSession(sessionId);
        }
        break;
      }
      case 'catalog_updated': {
        const payload = data as CatalogUpdatedPayload;
        const store = useSessionStore.getState();
        if (payload.catalog) {
          store.setCatalog(payload.catalog);
        } else if (
          Array.isArray(payload.folders)
          && isCatalogSessionsDelta(payload.sessions_delta)
        ) {
          for (const [sessionId, assignment] of Object.entries(payload.sessions_delta)) {
            if (assignment === null) abortHydration(sessionId);
          }
          store.applyCatalogDelta(payload.folders, payload.sessions_delta);
        }
        break;
      }
      case 'session_list': {
        const meta = streamMetaRef.current;
        if (!meta) throw new Error('session_list arrived without stream_meta');
        const snapshot = readSessionList(data);
        abortAllHydrations();
        useSessionStore.getState().applyFeedSnapshot(snapshot);
        usePlannerStore.getState().invalidate('replay');
        lastEventIdRef.current = meta.latestId;
        instanceIdRef.current = meta.instanceId;
        break;
      }
      case 'card_updated':
        if (api && typeof data?.cardId === 'string') {
          void refreshCard(api, data.cardId).catch((error) => {
            console.warn('[cards] card refresh failed', error);
          });
        }
        break;
    }
    const plannerSource = plannerSourceForStreamEvent(type);
    if (plannerSource) usePlannerStore.getState().invalidate(plannerSource);
  }, [abortAllHydrations, abortHydration, api, applySessionUpdated, isCurrentScope]);

  const eventTypes = useMemo(
    () => CATALOG_STREAM_EVENTS.filter((type) => type !== 'replay_gap'),
    [],
  );

  useSSEStream({
    diagnosticsSource: 'feed_stream',
    onConnecting: () => { streamMetaRef.current = null; },
    urlBuilder: () => api
      ? api.catalogStreamUrl(lastEventIdRef.current, instanceIdRef.current, FEED_CATALOG_STREAM_SCOPE)
      : '',
    eventTypes,
    enabled: !!api,
    connectionKey: `catalog-retry:${catalogRetryRequest}`,
    scopeGeneration: scope.generation,
    onEvent: (type, value, eventId) => {
      if (!isCurrentScope()) return;
      if (type === 'stream_meta') {
        streamMetaRef.current = readStreamMeta(value);
        return;
      }
      applyCatalogEvent(type, value);
      const meta = streamMetaRef.current;
      if (meta) instanceIdRef.current = meta.instanceId;
      if (type !== 'session_list' && eventId) lastEventIdRef.current = eventId;
    },
    onError: (error) => {
      if (!isCurrentScope()) return;
      if (!useSessionStore.getState().catalogReady) {
        useSessionStore.getState().markCatalogLoadFailed();
      }
      console.warn('[useSessionsStream] SSE error:', error);
    },
  });
}

function applySessionUpdatedPayload(data: Record<string, unknown>): Partial<Session> {
  return applySessionUpdated(data);
}
