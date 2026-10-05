import { create } from 'zustand';
import type {
  Session,
  Catalog,
  CatalogSessionsDelta,
  Folder,
  SessionEndedReconciliation,
} from '../api/types';
import type { FeedPage } from '../api/feedPage';
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

type FeedPageState = {
  hasMore: boolean;
  nextCursor: string | null;
  status: 'idle' | 'loading' | 'error';
};

interface SessionStore {
  scopeGeneration: string;
  sessions: Record<string, Session>;
  catalog: Catalog;
  feedMembership: Record<string, 'candidate' | 'excluded'>;
  feedPage: FeedPageState;
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
  upsertSession: (session: Session, options?: { feedEvent?: true }) => void;
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
   * feed snapshot에는 사용하지 않는다. 상세 cache까지 삭제될 수 있다.
   */
  reconcileSessions: (validIds: Set<string>) => void;
  applyFeedSnapshot: (snapshot: FeedPage & { folders: Folder[] }) => void;
  beginFeedPage: (fromStatus: 'idle' | 'error') => FeedPageState | null;
  appendFeedPage: (page: FeedPage, expectedPage: FeedPageState) => void;
  failFeedPage: (expectedPage: FeedPageState) => void;
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
  feedMembership: Record<string, 'candidate' | 'excluded'>,
): string[] {
  const candidates = Object.keys(feedMembership)
    .filter((sessionId) => feedMembership[sessionId] === 'candidate')
    .flatMap((sessionId) => sessions[sessionId] ? [sessions[sessionId]] : []);
  return filterFeedSessions(candidates, catalog, { catalogReady })
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

function initialSessionState(scopeGeneration = captureAuthScope().generation) {
  return {
    scopeGeneration,
    sessions: {},
    catalog: { folders: [], sessions: {} } as Catalog,
    feedMembership: {},
    feedPage: { hasMore: false, nextCursor: null, status: 'idle' as const },
    catalogReady: false,
    catalogLoadState: 'loading' as const,
    catalogRetryRequest: 0,
    feedSessionIds: [],
    sessionChangeSerial: 0,
    lastChangedSessionId: null,
    pendingAttentionVersionsBySession: {},
  };
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  ...initialSessionState(),
  setSessions: (list) =>
    set((state) => {
      const sessions = buildSessionMap(list);
      const feedMembership = Object.fromEntries(
        Object.entries(state.feedMembership).filter(([sessionId]) => sessions[sessionId]),
      );
      return {
        sessions,
        feedMembership,
        pendingAttentionVersionsBySession: buildPendingAttentionVersions(sessions),
        feedSessionIds: computeFeedSessionIds(
          sessions,
          state.catalog,
          state.catalogReady,
          feedMembership,
        ),
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: null,
      };
    }),
  upsertSession: (session, options) =>
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
      const shouldPromote = options?.feedEvent === true
        && state.feedMembership[sessionId] !== 'excluded';
      const membershipChanged = shouldPromote
        && state.feedMembership[sessionId] !== 'candidate';
      if (shallowEqualSession(existing, nextSession) && !membershipChanged) return state;
      const sessions = { ...state.sessions, [sessionId]: nextSession };
      const shouldRecomputeFeed = hasListAffectingChange(existing, nextSession);
      const feedMembership = membershipChanged
        ? { ...state.feedMembership, [sessionId]: 'candidate' as const }
        : state.feedMembership;
      return {
        sessions,
        feedMembership,
        ...(attention.versionState
          ? {
              pendingAttentionVersionsBySession: {
                ...state.pendingAttentionVersionsBySession,
                [sessionId]: attention.versionState,
              },
            }
          : {}),
        feedSessionIds: shouldRecomputeFeed || membershipChanged
          ? computeFeedSessionIds(
              sessions,
              state.catalog,
              state.catalogReady,
              feedMembership,
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
              state.feedMembership,
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
              state.feedMembership,
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
              state.feedMembership,
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
              state.feedMembership,
            )
          : state.feedSessionIds,
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: agentSessionId,
      };
    }),
  deleteSession: (agentSessionId) =>
    set((state) => {
      if (!state.sessions[agentSessionId] && !state.feedMembership[agentSessionId]) {
        return state;
      }
      const { [agentSessionId]: _, ...rest } = state.sessions;
      const { [agentSessionId]: _version, ...restVersions } =
        state.pendingAttentionVersionsBySession;
      const { [agentSessionId]: _membership, ...feedMembership } = state.feedMembership;
      return {
        sessions: rest,
        pendingAttentionVersionsBySession: restVersions,
        feedMembership,
        feedSessionIds: computeFeedSessionIds(
          rest,
          state.catalog,
          state.catalogReady,
          feedMembership,
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
      const feedMembership = Object.fromEntries(
        Object.entries(state.feedMembership).filter(([sessionId]) => validIds.has(sessionId)),
      );
      if (!changed && Object.keys(feedMembership).length === Object.keys(state.feedMembership).length) {
        return state;
      }
      return {
        sessions: next,
        feedMembership,
        pendingAttentionVersionsBySession: Object.fromEntries(
          Object.entries(state.pendingAttentionVersionsBySession)
            .filter(([sessionId]) => validIds.has(sessionId)),
        ),
        feedSessionIds: computeFeedSessionIds(
          next,
          state.catalog,
          state.catalogReady,
          feedMembership,
        ),
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: null,
      };
    }),
  applyFeedSnapshot: (snapshot) =>
    set((state) => {
      const sessions = { ...state.sessions };
      let pendingAttentionVersionsBySession = state.pendingAttentionVersionsBySession;
      const feedMembership: SessionStore['feedMembership'] = {};
      const catalogSessions = { ...state.catalog.sessions };
      for (const row of snapshot.sessions) {
        const sessionId = row.agentSessionId;
        if (!sessionId) continue;
        const attention = mergeSessionAttentionSnapshot(
          sessions[sessionId],
          row,
          pendingAttentionVersionsBySession[sessionId],
        );
        sessions[sessionId] = preserveNewestLastMessage(sessions[sessionId], attention.session);
        if (attention.versionState) {
          if (pendingAttentionVersionsBySession === state.pendingAttentionVersionsBySession) {
            pendingAttentionVersionsBySession = { ...pendingAttentionVersionsBySession };
          }
          pendingAttentionVersionsBySession[sessionId] = attention.versionState;
        }
        feedMembership[sessionId] = 'candidate';
        catalogSessions[sessionId] = {
          folderId: row.folderId ?? null,
          displayName: row.displayName ?? null,
        };
      }
      const catalog = { folders: snapshot.folders, sessions: catalogSessions };
      return {
        sessions,
        pendingAttentionVersionsBySession,
        catalog,
        feedMembership,
        feedPage: {
          hasMore: snapshot.hasMore,
          nextCursor: snapshot.nextCursor,
          status: 'idle' as const,
        },
        catalogReady: true,
        catalogLoadState: 'ready' as const,
        feedSessionIds: computeFeedSessionIds(sessions, catalog, true, feedMembership),
        sessionChangeSerial: state.sessionChangeSerial + 1,
        lastChangedSessionId: null,
      };
    }),
  beginFeedPage: (fromStatus) => {
    const current = get().feedPage;
    if (current.status !== fromStatus) return null;
    const expectedPage: FeedPageState = { ...current, status: 'loading' };
    set({ feedPage: expectedPage });
    return expectedPage;
  },
  appendFeedPage: (page, expectedPage) =>
    set((state) => {
      if (state.feedPage !== expectedPage || state.feedPage.status !== 'loading') return state;
      const sessions = { ...state.sessions };
      let pendingAttentionVersionsBySession = state.pendingAttentionVersionsBySession;
      const feedMembership = { ...state.feedMembership };
      const catalogSessions = { ...state.catalog.sessions };
      let changed = false;
      for (const row of page.sessions) {
        const sessionId = row.agentSessionId;
        if (!sessionId) continue;
        const existing = sessions[sessionId];
        const attention = mergeSessionAttentionSnapshot(
          existing,
          row,
          pendingAttentionVersionsBySession[sessionId],
        );
        const nextSession = preserveNewestLastMessage(existing, attention.session);
        if (!shallowEqualSession(existing, nextSession)) {
          changed = true;
          sessions[sessionId] = nextSession;
        }
        if (attention.versionState) {
          if (pendingAttentionVersionsBySession === state.pendingAttentionVersionsBySession) {
            pendingAttentionVersionsBySession = { ...pendingAttentionVersionsBySession };
          }
          pendingAttentionVersionsBySession[sessionId] = attention.versionState;
        }
        if (feedMembership[sessionId] !== 'excluded') feedMembership[sessionId] = 'candidate';
        catalogSessions[sessionId] = {
          folderId: row.folderId ?? null,
          displayName: row.displayName ?? null,
        };
      }
      const catalog = { ...state.catalog, sessions: catalogSessions };
      return {
        sessions,
        pendingAttentionVersionsBySession,
        catalog,
        feedMembership,
        feedPage: { hasMore: page.hasMore, nextCursor: page.nextCursor, status: 'idle' as const },
        feedSessionIds: computeFeedSessionIds(sessions, catalog, state.catalogReady, feedMembership),
        ...(changed ? {
          sessionChangeSerial: state.sessionChangeSerial + 1,
          lastChangedSessionId: null,
        } : {}),
      };
    }),
  failFeedPage: (expectedPage) =>
    set((state) => state.feedPage === expectedPage && state.feedPage.status === 'loading'
      ? { feedPage: { ...expectedPage, status: 'error' } }
      : state),
  setCatalog: (catalog) =>
    set((state) => {
      return {
        catalog,
        feedSessionIds: computeFeedSessionIds(
          state.sessions,
          catalog,
          state.catalogReady,
          state.feedMembership,
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
      const feedMembership = { ...state.feedMembership };
      for (const [sessionId, assignment] of Object.entries(sessionsDelta)) {
        feedMembership[sessionId] = assignment === null ? 'excluded' : 'candidate';
      }
      return {
        catalog,
        feedMembership,
        feedSessionIds: computeFeedSessionIds(
          state.sessions,
          catalog,
          state.catalogReady,
          feedMembership,
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
      const feedMembership = { ...state.feedMembership, [agentSessionId]: 'candidate' as const };
      return {
        catalog,
        feedMembership,
        feedSessionIds: computeFeedSessionIds(
          state.sessions,
          catalog,
          state.catalogReady,
          feedMembership,
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
