import { act, renderHook } from '@testing-library/react-native';
import type { Session } from '../../api/types';
import { useSessionStore } from '../../store/sessionStore';
import { useSessionsStream } from '../useSessionsStream';

const mockUseSSEStream = jest.fn();
const originalFetch = global.fetch;

jest.mock('../useSSEStream', () => ({
  CATALOG_STREAM_EVENTS: [
    'stream_meta', 'session_list', 'session_updated', 'folder_updated',
  ],
  useSSEStream: (options: unknown) => mockUseSSEStream(options),
}));

jest.mock('../../store/settingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: { serverUrl: string }) => unknown) => selector({ serverUrl: 'https://feed.test' }),
    { getState: () => ({ serverUrl: 'https://feed.test' }), subscribe: () => () => undefined },
  ),
}));

jest.mock('../../store/authStore', () => ({
  useAuthStore: Object.assign(jest.fn(), {
    getState: () => ({ jwt: null, rejectAuth: jest.fn() }),
    subscribe: () => () => undefined,
  }),
}));

function session(id: string, index: number): Session {
  const review = index >= 7;
  return {
    agentSessionId: id,
    displayName: `Session ${id}`,
    status: review ? 'completed' : 'running',
    reviewRequired: review,
    reviewState: review ? 'needs_review' : 'not_required',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    folderId: 'visible',
  };
}

function pageRows(start: number): Session[] {
  return Array.from({ length: 30 }, (_, index) => session(`page-${start + index}`, index + start));
}

function snapshotPayload(rows: Session[], cursor: string | null = '30') {
  return {
    folders: [{ id: 'visible', name: 'Visible', sortOrder: 0 }],
    sessions: rows,
    total: 411,
    hasMore: cursor !== null,
    nextCursor: cursor,
  };
}

function options() {
  return mockUseSSEStream.mock.calls.at(-1)?.[0] as {
    onEvent: (type: string, data: unknown, id?: string) => void;
    urlBuilder: () => string;
  };
}

function emit(type: string, data: unknown, id?: string) {
  act(() => options().onEvent(type, data, id));
}

function addSecondPage(rows: Session[]) {
  const store = useSessionStore.getState();
  const expected = store.beginFeedPage('idle');
  if (!expected) throw new Error('Feed page was not idle');
  useSessionStore.getState().appendFeedPage({
    sessions: rows,
    total: 411,
    hasMore: true,
    nextCursor: '60',
  }, expected);
}

beforeEach(() => {
  mockUseSSEStream.mockReset();
  global.fetch = jest.fn();
  useSessionStore.setState({
    sessions: {},
    catalog: { folders: [], sessions: {} },
    feedMembership: {},
    feedSessionIds: [],
    feedPage: { hasMore: false, nextCursor: null, status: 'idle' },
    catalogReady: false,
    catalogLoadState: 'loading',
    catalogRetryRequest: 0,
    pendingAttentionVersionsBySession: {},
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test('복귀 session_list는 60행 후보를 첫 30행으로 바꾸고 상세 cache를 보존한다', () => {
  const hook = renderHook(() => useSessionsStream());
  emit('stream_meta', { instance_id: 'node-a', latest_id: 100 });
  emit('session_list', snapshotPayload(pageRows(0)));
  addSecondPage(pageRows(30));
  const detail = {
    agentSessionId: 'detail-only',
    displayName: '열린 상세',
    status: 'completed',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
  } as Session;
  useSessionStore.getState().mergeSessions([detail]);
  expect(useSessionStore.getState().feedMembership).toHaveProperty('page-59');

  const refreshedRows = pageRows(100);
  emit('stream_meta', { instance_id: 'node-b', latest_id: 700 });
  emit('session_list', snapshotPayload(refreshedRows));

  const store = useSessionStore.getState();
  expect(store.feedSessionIds).toHaveLength(30);
  expect(Object.values(store.feedMembership)).toHaveLength(30);
  expect(store.feedMembership['page-59']).toBeUndefined();
  expect(store.feedMembership['page-100']).toBe('candidate');
  expect(store.sessions['page-59']).toBeDefined();
  expect(store.sessions['detail-only']).toBe(detail);
  expect(store.feedPage).toMatchObject({ hasMore: true, nextCursor: '30', status: 'idle' });
  expect(global.fetch).not.toHaveBeenCalled();
  hook.unmount();
});

test('복귀 재생만 오면 60행 후보를 유지하며 받은 델타를 적용한다', () => {
  const hook = renderHook(() => useSessionsStream());
  emit('stream_meta', { instance_id: 'node-a', latest_id: 100 });
  emit('session_list', snapshotPayload(pageRows(0)));
  addSecondPage(pageRows(30));
  const memberships = useSessionStore.getState().feedMembership;

  emit('session_updated', {
    agent_session_id: 'page-30',
    status: 'running',
    updated_at: '2026-10-03T00:00:00Z',
  }, '101');

  expect(useSessionStore.getState().feedMembership).toBe(memberships);
  expect(useSessionStore.getState().feedMembership).toHaveProperty('page-59');
  expect(useSessionStore.getState().sessions['page-30'].status).toBe('running');
  expect(useSessionStore.getState().feedSessionIds).toHaveLength(60);
  expect(options().urlBuilder()).toContain('lastEventId=101');
  expect(global.fetch).not.toHaveBeenCalled();
  hook.unmount();
});

test('metadata alone does not advance the cursor; session_list and later events do', () => {
  const hook = renderHook(() => useSessionsStream());
  expect(new URL(options().urlBuilder()).searchParams.has('lastEventId')).toBe(false);

  emit('stream_meta', { instance_id: 'node-a', latest_id: 100 });
  expect(new URL(options().urlBuilder()).searchParams.has('lastEventId')).toBe(false);

  emit('session_list', snapshotPayload(pageRows(0)));
  expect(new URL(options().urlBuilder()).searchParams.get('lastEventId')).toBe('100');
  expect(new URL(options().urlBuilder()).searchParams.get('instanceId')).toBe('node-a');

  emit('session_updated', { agent_session_id: 'page-0', status: 'running' }, '101');
  expect(new URL(options().urlBuilder()).searchParams.get('lastEventId')).toBe('101');
  hook.unmount();
});
