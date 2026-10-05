import type { Session } from '../../api/types';
import { useSessionStore } from '../sessionStore';

function session(agentSessionId: string, overrides: Partial<Session> = {}): Session {
  return {
    agentSessionId,
    displayName: agentSessionId,
    status: 'running',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  useSessionStore.setState({
    sessions: {},
    catalog: { folders: [], sessions: {} },
    feedMembership: {},
    feedSessionIds: [],
    feedPage: { hasMore: false, nextCursor: null, status: 'idle' },
    catalogReady: false,
    catalogLoadState: 'loading',
    pendingAttentionVersionsBySession: {},
  });
});

test('snapshot atomically replaces feed candidates and keeps detail cache', () => {
  const detail = session('detail-only', { status: 'completed' });
  useSessionStore.getState().mergeSessions([detail]);
  const rows = [session('running-1'), session('running-2')];
  const observed: string[][] = [];
  const unsubscribe = useSessionStore.subscribe((state) => {
    observed.push([...state.feedSessionIds]);
  });

  useSessionStore.getState().applyFeedSnapshot({
    folders: [{ id: 'folder-1', name: '폴더', sortOrder: 0 }],
    sessions: rows,
    total: 411,
    hasMore: true,
    nextCursor: '30',
  });
  unsubscribe();

  expect(observed).toEqual([['running-2', 'running-1']]);
  expect(useSessionStore.getState().sessions['detail-only']).toBe(detail);
  expect(useSessionStore.getState().feedMembership).toEqual({
    'running-1': 'candidate',
    'running-2': 'candidate',
  });
  expect(useSessionStore.getState().feedPage).toEqual({
    hasMore: true,
    nextCursor: '30',
    status: 'idle',
  });
});

test('ordinary cache merges do not add feed candidates and excluded membership survives patches', () => {
  const store = useSessionStore.getState();
  store.applyFeedSnapshot({ folders: [], sessions: [session('shown')], total: 1, hasMore: false, nextCursor: null });
  store.mergeSessions([session('folder-cache')]);
  store.applyCatalogDelta([], { excluded: null });
  store.mergeSessions([session('excluded', { status: 'running' })]);
  useSessionStore.getState().updateSession('excluded', { updatedAt: '2026-10-03T00:00:00Z' });

  expect(useSessionStore.getState().feedMembership).toMatchObject({
    shown: 'candidate',
    excluded: 'excluded',
  });
  expect(useSessionStore.getState().feedSessionIds).toEqual(['shown']);
});
