import { create } from 'zustand';
import type {
  Session,
  Catalog,
  CatalogSessionsDelta,
  Folder,
  SessionEndedReconciliation,
} from '../api/types';
import { preserveNewestLastMessage } from '../lib/session-last-message';
import { filterFeedSessions } from '../lib/feed-filter';
import { getSessionFeedActivityMs } from '../lib/session-feed-activity';
import {
  applyPendingAttentionDelta,
  createPendingAttentionVersionState,
  hasPendingAttentionSnapshot,
  mergeSessionAttentionSnapshot,
  type PendingAttentionVersionState,
} from '../lib/session-attention';
import { captureAuthScope, subscribeAuthScope } from '../lib/auth-scope';

interface SessionStore {
  scopeGeneration: string;
  sessions: Record<string, Session>;
  catalog: Catalog;
  /**
   * feed_only catalog SSE가 null assignment로 내보낸 세션. 상세 화면의 Session은
   * 유지하되, stale session.folderId fallback으로 피드 카드가 되살아나지 않게 한다.
   */
  feedScopeTombstoneIds: Record<string, true>;
  /** catalog folder settings가 한 번 이상 도착했는지. 피드 첫 paint 가드에 사용한다. */
  catalogReady: boolean;
  /** 초기 catalog snapshot의 사용자 표시 상태. 정상적인 0건은 ready와 구분한다. */
  catalogLoadState: 'loading' | 'ready' | 'error';
  /** 사용자의 명시 재시도마다 증가하며 REST snapshot·SSE의 새 연결 단위가 된다. */
  catalogRetryRequest: number;
  /**
   * 피드 FlatList의 정렬·필터 정본이자 그룹 projection 재계산 신호.
   * 화면은 이 id 배열만 구독한다. 유효 lastMessage.timestamp와
   * status/reviewState/nodeId처럼 목록 배치에 영향을 주는 값만 배열 참조를 바꾸고,
   * profile/preview 변경은 해당 카드만 갱신한다.
   */
  feedSessionIds: string[];
  /**
   * useFolderPagination이 React 렌더 구독 없이 store.subscribe로 변경분만 읽기 위한 메타.
   * null은 setSessions/mergeSessions/reconcile처럼 다건 변경이라 필요 시 fallback scan한다는 뜻.
   */
  sessionChangeSerial: number;
  lastChangedSessionId: string | null;
  /** Snapshot baseline + identity별 live revision/tombstone. UI는 sessions만 구독한다. */
  pendingAttentionVersionsBySession: Record<string, PendingAttentionVersionState>;
  setSessions: (sessions: Session[]) => void;
  upsertSession: (session: Session) => void;
  /**
   * 여러 Session을 한 번에 upsert한다 (FolderContentsScreen 진입 시 폴더별 페치 결과 등).
   * 기존 entry는 갱신, 없으면 추가. setSessions와 달리 다른 entry를 지우지 않는다.
   */
  mergeSessions: (sessions: Session[]) => void;
  /**
   * 부분 정보(SSE session_updated delta)로 기존 세션을 갱신한다.
   *
   * 기존 entry가 없으면 noop이다 — delta는 status/updatedAt 등 부분 정보만 담고 있어
   * 정상 Session 객체를 구성할 수 없다. 없는 ID로 부분 entry를 만들면
   * FeedScreen의 정렬 기준(updatedAt NaN)과 FolderContentsScreen 등에서
   * 회귀가 일어나므로 명시적 실패 원칙(design-principles §4)에 따라 skip이 옳다.
   */
  updateSession: (agentSessionId: string, partial: Partial<Session>) => void;
  applyPendingAttentionsDelta: (
    agentSessionId: string,
    delta: unknown,
    attentionRevision: unknown,
  ) => void;
  /** chat session_ended를 정본 delta 유실 시의 보조 신호로, 더 새로울 때만 적용한다. */
  reconcileSessionEnded: (
    agentSessionId: string,
    ended: SessionEndedReconciliation,
  ) => void;
  deleteSession: (agentSessionId: string) => void;
  /**
   * unscoped authoritative session list로 stale entry를 청소한다.
   *
   * feed_only snapshot에는 사용하면 안 된다. scoped assignment가 없는 열린 상세 cache까지
   * 삭제하게 되므로, 그 경로는 setFeedCatalogSnapshot을 쓴다.
   */
  reconcileSessions: (validIds: Set<string>) => void;
  /**
   * feed_only snapshot을 피드 membership 정본으로 적용한다.
   * snapshot에 없는 상세 cache는 보존하고, 피드에서만 tombstone 처리한다.
   */
  setFeedCatalogSnapshot: (catalog: Catalog) => void;
  setCatalog: (catalog: Catalog) => void;
  markCatalogLoadFailed: () => void;
  retryCatalog: () => void;
  applyCatalogDelta: (
    folders: Folder[],
    sessionsDelta: CatalogSessionsDelta,
  ) => void;
  assignSessionToCatalog: (
    agentSessionId: string,
    folderId: string | null,
    displayName?: string | null,
  ) => void;
}

const FEED_PROJECTION_KEYS: Array<keyof Session> = [
  'folderId',
  'sessionType',
  'status',
  'reviewState',
  'nodeId',
];

function buildSessionMap(list: Session[]): Record<string, Session> {
  return Object.fromEntries(
    list.filter((s) => !!s?.agentSessionId).map((s) => [s.agentSessionId, s]),
  );
}

function buildPendingAttentionVersions(
  sessions: Record<string, Session>,
): Record<string, PendingAttentionVersionState> {
  const versions: Record<string, PendingAttentionVersionState> = {};
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (!hasPendingAttentionSnapshot(session)) continue;
    versions[sessionId] = createPendingAttentionVersionState(
      session.attentionRevision ?? 0,
    );
  }
  return versions;
}

function computeFeedSessionIds(
  sessions: Record<string, Session>,
  catalog: Catalog,
  catalogReady: boolean,
  feedScopeTombstoneIds: Record<string, true>,
): string[] {
  return filterFeedSessions(sessions, catalog, { catalogReady })
    .filter((session) => !feedScopeTombstoneIds[session.agentSessionId])
    .map((session) => session.agentSessionId);
}

function shallowEqualSession(a: Session | undefined, b: Session | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key as keyof Session] !== b[key as keyof Session]) return false;
  }
  return true;
}

function hasListAffectingChange(
  prev: Session | undefined,
  next: Session | undefined,
): boolean {
  if (!prev || !next) return true;
  return (
    getSessionFeedActivityMs(prev) !== getSessionFeedActivityMs(next)
    || (
      ((prev.pendingAttentions?.length ?? 0) > 0)
      !== ((next.pendingAttentions?.length ?? 0) > 0)
    )
    || FEED_PROJECTION_KEYS.some((key) => prev[key] !== next[key])
  );
}

function mergeCatalogSessionsDelta(
  current: Catalog['sessions'],
  delta: CatalogSessionsDelta,
): Catalog['sessions'] {
  let next = current;
  for (const [sessionId, assignment] of Object.entries(delta)) {
    const existing = next[sessionId];
    if (assignment === null) {
      if (!existing) continue;
      if (next === current) next = { ...current };
      delete next[sessionId];
      continue;
    }
    if (
      existing?.folderId === assignment.folderId
      && existing.displayName === assignment.displayName
    ) {
      continue;
    }
    if (next === current) next = { ...current };
    next[sessionId] = assignment;
  }
  return next;
}

function mergeFeedScopeTombstoneIds(
  current: Record<string, true>,
  delta: CatalogSessionsDelta,
): Record<string, true> {
  let next = current;
  for (const [sessionId, assignment] of Object.entries(delta)) {
    const shouldTombstone = assignment === null;
    const isTombstoned = current[sessionId] === true;
    if (shouldTombstone === isTombstoned) continue;
    if (next === current) next = { ...current };
    if (shouldTombstone) next[sessionId] = true;
    else delete next[sessionId];
  }
  return next;
}

function clearResolvedFeedScopeTombstones(
  current: Record<string, true>,
  assignments: Catalog['sessions'],
): Record<string, true> {
  let next = current;
  for (const sessionId of Object.keys(current)) {
    if (assignments[sessionId] === undefined) continue;
    if (next === current) next = { ...current };
    delete next[sessionId];
  }
  return next;
}

function retainFeedScopeTombstonesForSessions(
  current: Record<string, true>,
  sessions: Record<string, Session>,
): Record<string, true> {
  let next = current;
  for (const sessionId of Object.keys(current)) {
    if (sessions[sessionId]) continue;
    if (next === current) next = { ...current };
    delete next[sessionId];
  }
  return next;
}

function reconcileFeedScopeTombstonesForSnapshot(
  current: Record<string, true>,
  sessions: Record<string, Session>,
  assignments: Catalog['sessions'],
): Record<string, true> {
  let next = current;
  const knownIds = new Set([...Object.keys(current), ...Object.keys(sessions)]);
  for (const sessionId of knownIds) {
    // 없는 cache에는 tombstone을 남길 이유가 없고, cache만 남은 세션은 feed snapshot의
    // assignment 부재로 피드에서만 숨긴다. 실제 cache 삭제는 session_deleted가 맡는다.
    const shouldTombstone = sessions[sessionId] !== undefined
      && assignments[sessionId] === undefined;
    const isTombstoned = current[sessionId] === true;
    if (shouldTombstone === isTombstoned) continue;
    if (next === current) next = { ...current };
    if (shouldTombstone) next[sessionId] = true;
    else delete next[sessionId];
  }
  return next;
}

function initialSessionState(scopeGeneration = captureAuthScope().generation) {
  return {
    scopeGeneration,
    sessions: {},
    catalog: { folders: [], sessions: {} } as Catalog,
    feedScopeTombstoneIds: {},
    catalogReady: false,
    catalogLoadState: 'loading' as const,
    catalogRetryRequest: 0,
    feedSessionIds: [],
    sessionChangeSerial: 0,
    lastChangedSessionId: null,
    pendingAttentionVersionsBySession: {},
  };
}

export const useSessionStore = create<SessionStore>((set) => ({
  ...initialSessionState(),
  setSessions: (list) =>
    set((state) => {
      const sessions = buildSessionMap(list);
      const feedScopeTombstoneIds = retainFeedScopeTombstonesForSessions(
        state.feedScopeTombstoneIds,
        sessions,
      );
      return {
        sessions,
        feedScopeTombstoneIds,
        pendingAttentionVersionsBySession: buildPendingAttentionVersions(sessions),
        feedSessionIds: computeFeedSessionIds(
          sessions,
          state.catalog,
          state.catalogReady,
          feedScopeTombstoneIds,
        ),
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: null,
      };
    }),
  upsertSession: (session) =>
    set((state) => {
      if (!session?.agentSessionId) return state;
      const sessionId = session.agentSessionId;
      const existing = state.sessions[sessionId];
      const attention = mergeSessionAttentionSnapshot(
        existing,
        session,
        state.pendingAttentionVersionsBySession[sessionId],
      );
      const nextSession = preserveNewestLastMessage(existing, attention.session);
      if (shallowEqualSession(existing, nextSession)) return state;
      const sessions = { ...state.sessions, [sessionId]: nextSession };
      const shouldRecomputeFeed = hasListAffectingChange(existing, nextSession);
      return {
        sessions,
        ...(attention.versionState
          ? {
              pendingAttentionVersionsBySession: {
                ...state.pendingAttentionVersionsBySession,
                [sessionId]: attention.versionState,
              },
            }
          : {}),
        feedSessionIds: shouldRecomputeFeed
          ? computeFeedSessionIds(
              sessions,
              state.catalog,
              state.catalogReady,
              state.feedScopeTombstoneIds,
            )
          : state.feedSessionIds,
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: session.agentSessionId,
      };
    }),
  mergeSessions: (list) =>
    set((state) => {
      if (list.length === 0) return state;
      const next = { ...state.sessions };
      let nextAttentionVersions = state.pendingAttentionVersionsBySession;
      let changed = false;
      let shouldRecomputeFeed = false;
      for (const s of list) {
        if (!s?.agentSessionId) continue;
        const existing = next[s.agentSessionId];
        const attention = mergeSessionAttentionSnapshot(
          existing,
          s,
          nextAttentionVersions[s.agentSessionId],
        );
        const nextSession = preserveNewestLastMessage(existing, attention.session);
        if (shallowEqualSession(existing, nextSession)) continue;
        changed = true;
        if (hasListAffectingChange(existing, nextSession)) shouldRecomputeFeed = true;
        next[s.agentSessionId] = nextSession;
        if (attention.versionState) {
          if (nextAttentionVersions === state.pendingAttentionVersionsBySession) {
            nextAttentionVersions = { ...nextAttentionVersions };
          }
          nextAttentionVersions[s.agentSessionId] = attention.versionState;
        }
      }
      if (!changed) return state;
      return {
        sessions: next,
        pendingAttentionVersionsBySession: nextAttentionVersions,
        feedSessionIds: shouldRecomputeFeed
          ? computeFeedSessionIds(
              next,
              state.catalog,
              state.catalogReady,
              state.feedScopeTombstoneIds,
            )
          : state.feedSessionIds,
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: null,
      };
    }),
  updateSession: (agentSessionId, partial) =>
    set((state) => {
      const existing = state.sessions[agentSessionId];
      if (!existing) return state; // delta만으로는 entry 못 만든다 → skip
      const nextSession = preserveNewestLastMessage(existing, { ...existing, ...partial });
      if (shallowEqualSession(existing, nextSession)) return state;
      const sessions = {
        ...state.sessions,
        [agentSessionId]: nextSession,
      };
      const shouldRecomputeFeed = hasListAffectingChange(existing, nextSession);
      return {
        sessions,
        feedSessionIds: shouldRecomputeFeed
          ? computeFeedSessionIds(
              sessions,
              state.catalog,
              state.catalogReady,
              state.feedScopeTombstoneIds,
            )
          : state.feedSessionIds,
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: agentSessionId,
      };
    }),
  applyPendingAttentionsDelta: (agentSessionId, delta, attentionRevision) =>
    set((state) => {
      const existing = state.sessions[agentSessionId];
      if (!existing) return state;
      const versionState = state.pendingAttentionVersionsBySession[agentSessionId]
        ?? createPendingAttentionVersionState(existing.attentionRevision ?? 0);
      const result = applyPendingAttentionDelta(
        existing.pendingAttentions ?? [],
        existing.attentionRevision ?? 0,
        versionState,
        agentSessionId,
        delta,
        attentionRevision,
      );
      const versionChanged = result.versionState !== versionState;
      const sessionChanged =
        result.pendingAttentions !== existing.pendingAttentions
        || result.attentionRevision !== existing.attentionRevision;
      if (!versionChanged && !sessionChanged) return state;

      const pendingAttentionVersionsBySession = {
        ...state.pendingAttentionVersionsBySession,
        [agentSessionId]: result.versionState,
      };
      if (!sessionChanged) return { pendingAttentionVersionsBySession };

      const nextSession = {
        ...existing,
        pendingAttentions: result.pendingAttentions,
        attentionRevision: result.attentionRevision,
      };
      const sessions = { ...state.sessions, [agentSessionId]: nextSession };
      return {
        pendingAttentionVersionsBySession,
        sessions,
        feedSessionIds: hasListAffectingChange(existing, nextSession)
          ? computeFeedSessionIds(
              sessions,
              state.catalog,
              state.catalogReady,
              state.feedScopeTombstoneIds,
            )
          : state.feedSessionIds,
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: agentSessionId,
      };
    }),
  reconcileSessionEnded: (agentSessionId, ended) =>
    set((state) => {
      const existing = state.sessions[agentSessionId];
      if (!existing) return state;
      if (
        existing.lastEventId !== undefined
        && ended.lastEventId <= existing.lastEventId
      ) {
        return state;
      }
      const nextSession = { ...existing, ...ended };
      const sessions = {
        ...state.sessions,
        [agentSessionId]: nextSession,
      };
      return {
        sessions,
        feedSessionIds: hasListAffectingChange(existing, nextSession)
          ? computeFeedSessionIds(
              sessions,
              state.catalog,
              state.catalogReady,
              state.feedScopeTombstoneIds,
            )
          : state.feedSessionIds,
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: agentSessionId,
      };
    }),
  deleteSession: (agentSessionId) =>
    set((state) => {
      if (!state.sessions[agentSessionId] && !state.feedScopeTombstoneIds[agentSessionId]) {
        return state;
      }
      const { [agentSessionId]: _, ...rest } = state.sessions;
      const { [agentSessionId]: _version, ...restVersions } =
        state.pendingAttentionVersionsBySession;
      const { [agentSessionId]: _tombstone, ...feedScopeTombstoneIds } =
        state.feedScopeTombstoneIds;
      return {
        sessions: rest,
        pendingAttentionVersionsBySession: restVersions,
        feedScopeTombstoneIds,
        feedSessionIds: computeFeedSessionIds(
          rest,
          state.catalog,
          state.catalogReady,
          feedScopeTombstoneIds,
        ),
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: agentSessionId,
      };
    }),
  reconcileSessions: (validIds) =>
    set((state) => {
      const next: Record<string, Session> = {};
      let changed = false;
      for (const [sid, s] of Object.entries(state.sessions)) {
        if (validIds.has(sid)) next[sid] = s;
        else changed = true;
      }
      const feedScopeTombstoneIds = retainFeedScopeTombstonesForSessions(
        state.feedScopeTombstoneIds,
        next,
      );
      if (!changed && feedScopeTombstoneIds === state.feedScopeTombstoneIds) {
        return state;
      }
      return {
        sessions: next,
        feedScopeTombstoneIds,
        pendingAttentionVersionsBySession: Object.fromEntries(
          Object.entries(state.pendingAttentionVersionsBySession)
            .filter(([sessionId]) => validIds.has(sessionId)),
        ),
        feedSessionIds: computeFeedSessionIds(
          next,
          state.catalog,
          state.catalogReady,
          feedScopeTombstoneIds,
        ),
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: null,
      };
    }),
  setFeedCatalogSnapshot: (catalog) =>
    set((state) => {
      const feedScopeTombstoneIds = reconcileFeedScopeTombstonesForSnapshot(
        state.feedScopeTombstoneIds,
        state.sessions,
        catalog.sessions,
      );
      return {
        catalog,
        feedScopeTombstoneIds,
        catalogReady: true,
        catalogLoadState: 'ready',
        feedSessionIds: computeFeedSessionIds(
          state.sessions,
          catalog,
          true,
          feedScopeTombstoneIds,
        ),
      };
    }),
  setCatalog: (catalog) =>
    set((state) => {
      const feedScopeTombstoneIds = clearResolvedFeedScopeTombstones(
        state.feedScopeTombstoneIds,
        catalog.sessions,
      );
      return {
        catalog,
        feedScopeTombstoneIds,
        catalogReady: true,
        catalogLoadState: 'ready',
        feedSessionIds: computeFeedSessionIds(
          state.sessions,
          catalog,
          true,
          feedScopeTombstoneIds,
        ),
      };
    }),
  markCatalogLoadFailed: () => set({ catalogLoadState: 'error' }),
  retryCatalog: () =>
    set((state) => ({
      catalogLoadState: 'loading',
      catalogRetryRequest: state.catalogRetryRequest + 1,
    })),
  applyCatalogDelta: (folders, sessionsDelta) =>
    set((state) => {
      const catalog = {
        folders,
        sessions: mergeCatalogSessionsDelta(
          state.catalog.sessions,
          sessionsDelta,
        ),
      };
      const feedScopeTombstoneIds = mergeFeedScopeTombstoneIds(
        state.feedScopeTombstoneIds,
        sessionsDelta,
      );
      return {
        catalog,
        feedScopeTombstoneIds,
        catalogReady: true,
        catalogLoadState: 'ready',
        feedSessionIds: computeFeedSessionIds(
          state.sessions,
          catalog,
          true,
          feedScopeTombstoneIds,
        ),
      };
    }),
  assignSessionToCatalog: (agentSessionId, folderId, displayName = null) =>
    set((state) => {
      if (!agentSessionId) return state;
      const catalog = {
        ...state.catalog,
        sessions: {
          ...state.catalog.sessions,
          [agentSessionId]: { folderId, displayName },
        },
      };
      const feedScopeTombstoneIds = clearResolvedFeedScopeTombstones(
        state.feedScopeTombstoneIds,
        { [agentSessionId]: { folderId, displayName } },
      );
      return {
        catalog,
        feedScopeTombstoneIds,
        feedSessionIds: computeFeedSessionIds(
          state.sessions,
          catalog,
          state.catalogReady,
          feedScopeTombstoneIds,
        ),
      };
    }),
}));

subscribeAuthScope((scope) => {
  useSessionStore.setState(initialSessionState(scope.generation));
});

export function isSessionStoreScopeCurrent(generation: string): boolean {
  return useSessionStore.getState().scopeGeneration === generation
    && captureAuthScope().generation === generation;
}

export function setSessionProjectionForScope(
  generation: string,
  projection: Partial<SessionStore>,
): boolean {
  if (!isSessionStoreScopeCurrent(generation)) return false;
  useSessionStore.setState(projection);
  return true;
}
