import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useSessionStore } from '../../store/sessionStore';
import { useSessionsStream } from '../useSessionsStream';

const mockUseSSEStream = jest.fn();
const originalFetch = global.fetch;

jest.mock('../useSSEStream', () => ({
  CATALOG_STREAM_EVENTS: [
    'stream_meta', 'session_list', 'session_created', 'session_updated',
    'session_deleted', 'catalog_updated', 'folder_updated', 'card_updated',
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

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as Response;
}

function session(id: string, overrides: Record<string, unknown> = {}) {
  return {
    agentSessionId: id,
    displayName: `Session ${id}`,
    status: 'completed',
    reviewState: 'acknowledged',
    reviewRequired: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    ...overrides,
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

function seedSnapshot(rows: ReturnType<typeof session>[]) {
  useSessionStore.getState().applyFeedSnapshot({
    folders: [],
    sessions: rows as any,
    total: rows.length,
    hasMore: false,
    nextCursor: null,
  });
}

function mountWithEmptySnapshot() {
  const hook = renderHook(() => useSessionsStream());
  emit('stream_meta', { instance_id: 'node-a', latest_id: 100 });
  emit('session_list', {
    folders: [], sessions: [], total: 0, hasMore: false, nextCursor: null,
  });
  return hook;
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

test('candidate session_updated patches the cache without a targeted lookup', () => {
  seedSnapshot([session('candidate', { status: 'running', reviewState: 'not_required' })]);
  const fetchMock = global.fetch as jest.Mock;
  renderHook(() => useSessionsStream());

  emit('session_updated', {
    agent_session_id: 'candidate',
    status: 'completed',
    review_state: 'needs_review',
    updated_at: '2026-10-03T00:00:00Z',
  }, '101');

  expect(useSessionStore.getState().sessions.candidate).toMatchObject({
    status: 'completed',
    reviewState: 'needs_review',
  });
  expect(useSessionStore.getState().feedMembership.candidate).toBe('candidate');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('excluded cached sessions apply patches but never become candidates or trigger lookup', () => {
  useSessionStore.getState().mergeSessions([session('excluded') as any]);
  useSessionStore.getState().applyCatalogDelta([], { excluded: null });
  const fetchMock = global.fetch as jest.Mock;
  renderHook(() => useSessionsStream());

  emit('session_updated', { agent_session_id: 'excluded', status: 'running' });

  expect(useSessionStore.getState().sessions.excluded.status).toBe('running');
  expect(useSessionStore.getState().feedMembership.excluded).toBe('excluded');
  expect(useSessionStore.getState().feedSessionIds).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a non-display patch does not revive a stale running cache row or look it up', () => {
  useSessionStore.getState().mergeSessions([session('stale', { status: 'running' }) as any]);
  const fetchMock = global.fetch as jest.Mock;
  renderHook(() => useSessionsStream());

  emit('session_updated', {
    agent_session_id: 'stale',
    updated_at: '2026-10-03T00:00:00Z',
    last_read_event_id: 25,
  });

  expect(useSessionStore.getState().sessions.stale.status).toBe('running');
  expect(useSessionStore.getState().feedMembership.stale).toBeUndefined();
  expect(useSessionStore.getState().feedSessionIds).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('an unknown running patch gets one full row before it returns to the feed', async () => {
  const fullRow = session('returned', { status: 'running', reviewState: 'not_required' });
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockResolvedValue(jsonResponse({ sessions: [fullRow] }));
  mountWithEmptySnapshot();

  emit('session_updated', { agent_session_id: 'returned', status: 'running' }, '101');
  expect(useSessionStore.getState().sessions.returned).toBeUndefined();
  expect(useSessionStore.getState().feedSessionIds).toEqual([]);

  await waitFor(() => expect(useSessionStore.getState().feedSessionIds).toContain('returned'));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const requested = new URL(fetchMock.mock.calls[0][0]);
  expect(requested.pathname).toBe('/api/sessions');
  expect(requested.searchParams.getAll('session_id')).toEqual(['returned']);
  expect(requested.searchParams.get('limit')).toBe('1');
  expect(useSessionStore.getState().sessions.returned).toMatchObject({
    displayName: 'Session returned',
    status: 'running',
  });
});

test('in-flight updates are coalesced into one lookup and the latest display state wins', async () => {
  let resolveResponse!: (response: Response) => void;
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
  mountWithEmptySnapshot();

  emit('session_updated', { agent_session_id: 'pending', status: 'running' }, '101');
  emit('session_updated', {
    agent_session_id: 'pending',
    review_state: 'needs_review',
    review_required: true,
  }, '102');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(useSessionStore.getState().sessions.pending).toBeUndefined();

  await act(async () => {
    resolveResponse(jsonResponse({ sessions: [session('pending')] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(useSessionStore.getState().sessions.pending).toMatchObject({
    status: 'running',
    reviewState: 'needs_review',
    reviewRequired: true,
  });
  expect(useSessionStore.getState().feedMembership.pending).toBe('candidate');
  expect(useSessionStore.getState().feedSessionIds).toContain('pending');
});

test.each([false, true])(
  'an in-flight completion patch wins over the hydrated running row (cached=%s)',
  async (cached) => {
    const sessionId = 'pending-completion';
    if (cached) {
      useSessionStore.getState().mergeSessions([
        session(sessionId, { status: 'completed', reviewState: 'acknowledged' }) as any,
      ]);
    }

    let resolveResponse!: (response: Response) => void;
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    mountWithEmptySnapshot();

    emit('session_updated', { agent_session_id: sessionId, status: 'running' }, '101');
    emit('session_updated', {
      agent_session_id: sessionId,
      status: 'completed',
      review_state: 'acknowledged',
    }, '102');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveResponse(jsonResponse({ sessions: [session(sessionId, { status: 'running' })] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useSessionStore.getState().sessions[sessionId]).toMatchObject({
      status: 'completed',
      reviewState: 'acknowledged',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

test('attention set and clear deltas received during hydration apply in order', async () => {
  const sessionId = 'pending-attention-clear';
  const attentionId = 'input_request:req-8';
  let resolveResponse!: (response: Response) => void;
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
  mountWithEmptySnapshot();
  const attention = {
    id: attentionId,
    sourceEventId: 1002,
    sessionId,
    kind: 'input_request',
    requestedAt: '2026-10-02T00:00:01Z',
    title: '입력 요청',
    body: '확인할까요?',
    requiresDetail: false,
  };

  emit('session_updated', {
    agent_session_id: sessionId,
    attention_revision: 1002,
    pending_attentions_delta: {
      [attentionId]: { revision: 1002, value: attention },
    },
  }, '101');
  emit('session_updated', {
    agent_session_id: sessionId,
    attention_revision: 1003,
    pending_attentions_delta: {
      [attentionId]: { revision: 1003, value: null },
    },
  }, '102');

  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveResponse(jsonResponse({ sessions: [session(sessionId, {
      attentionRevision: 1001,
      pendingAttentions: [],
    })] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(useSessionStore.getState().sessions[sessionId].pendingAttentions).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a valid response-needed patch hydrates one row and applies its attention delta', async () => {
  const fullRow = session('attention', {
    attentionRevision: 1001,
    pendingAttentions: [],
  });
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockResolvedValue(jsonResponse({ sessions: [fullRow] }));
  mountWithEmptySnapshot();
  const attention = {
    id: 'input_request:req-7',
    sourceEventId: 1002,
    sessionId: 'attention',
    kind: 'input_request',
    requestedAt: '2026-10-02T00:00:01Z',
    title: '입력 요청',
    body: '확인할까요?',
    requiresDetail: false,
  };

  emit('session_updated', {
    agent_session_id: 'attention',
    attention_revision: 1002,
    pending_attentions_delta: {
      'input_request:req-7': { revision: 1002, value: attention },
    },
  });

  await waitFor(() => expect(useSessionStore.getState().sessions.attention?.pendingAttentions).toHaveLength(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(useSessionStore.getState().feedSessionIds).toContain('attention');
});

test('session_created promotes its complete row into the feed', () => {
  mountWithEmptySnapshot();

  emit('session_created', { session: session('created', { status: 'running' }) });

  expect(useSessionStore.getState().feedMembership.created).toBe('candidate');
  expect(useSessionStore.getState().feedSessionIds).toContain('created');
});
