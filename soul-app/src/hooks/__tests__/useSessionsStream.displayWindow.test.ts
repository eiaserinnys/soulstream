import { act, renderHook } from '@testing-library/react-native';
import { useSessionStore } from '../../store/sessionStore';
import { useSessionsStream } from '../useSessionsStream';

const mockUseSSEStream = jest.fn();
const originalFetch = global.fetch;

jest.mock('../useSSEStream', () => ({
  CATALOG_STREAM_EVENTS: ['stream_meta', 'session_list', 'session_updated', 'folder_updated'],
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

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as Response;
}

function rows() {
  return Array.from({ length: 30 }, (_, index) => ({
    agentSessionId: `feed-${index}`,
    displayName: `Feed ${index}`,
    status: index < 7 ? 'running' : 'completed',
    reviewRequired: index >= 7,
    reviewState: index >= 7 ? 'needs_review' : 'not_required',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    folderId: 'visible',
  }));
}

function emit(type: string, data: unknown) {
  const options = mockUseSSEStream.mock.calls.at(-1)?.[0] as {
    onEvent: (eventType: string, payload: unknown, id?: string) => void;
  };
  act(() => options.onEvent(type, data));
}

beforeEach(() => {
  mockUseSSEStream.mockReset();
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
});

test('new start consumes one 30-row stream snapshot and makes no listing GET', async () => {
  const fetchMock = jest.fn().mockResolvedValue(response({ folders: [], sessions: [] }));
  global.fetch = fetchMock;
  const hook = renderHook(() => useSessionsStream());
  await act(async () => {});

  const options = mockUseSSEStream.mock.calls.at(-1)?.[0] as {
    urlBuilder: () => string;
  };
  const streamUrl = new URL(options.urlBuilder());
  emit('stream_meta', { latest_id: 500, instance_id: 'node-a' });
  emit('session_list', {
    type: 'session_list',
    folders: [{ id: 'visible', name: 'Visible', sortOrder: 0 }],
    sessions: rows(),
    total: 411,
    hasMore: true,
    nextCursor: '30',
  });

  expect(streamUrl.searchParams.get('feed_only')).toBe('true');
  expect(streamUrl.searchParams.get('feed_display')).toBe('true');
  expect(streamUrl.searchParams.get('limit')).toBe('30');
  expect(streamUrl.searchParams.has('snapshotCatchup')).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(useSessionStore.getState().feedSessionIds).toHaveLength(30);
  const received = useSessionStore.getState().feedSessionIds;
  expect(received.filter((id) => useSessionStore.getState().sessions[id].status === 'running')).toHaveLength(7);
  expect(received.filter((id) => useSessionStore.getState().sessions[id].reviewState === 'needs_review')).toHaveLength(23);
  expect(useSessionStore.getState().feedPage).toMatchObject({ hasMore: true, nextCursor: '30' });
  hook.unmount();
});

test('folder_updated does not fetch session or folder listings', async () => {
  const fetchMock = jest.fn().mockResolvedValue(response({ folders: [], sessions: [] }));
  global.fetch = fetchMock;
  const hook = renderHook(() => useSessionsStream());
  await act(async () => {});
  emit('stream_meta', { latest_id: 500, instance_id: 'node-a' });
  emit('session_list', { folders: [], sessions: rows(), total: 411, hasMore: true, nextCursor: '30' });

  emit('folder_updated', { folderId: 'visible' });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(useSessionStore.getState().feedSessionIds).toHaveLength(30);
  hook.unmount();
});

test('a pre-snapshot stream error retries only the stream and an empty snapshot becomes ready', async () => {
  const fetchMock = jest.fn();
  global.fetch = fetchMock;
  const hook = renderHook(() => useSessionsStream());
  await act(async () => {});
  const firstOptions = mockUseSSEStream.mock.calls.at(-1)?.[0] as {
    connectionKey: string;
    onError: (error: unknown) => void;
  };

  act(() => firstOptions.onError(new Error('stream unavailable')));
  expect(useSessionStore.getState().catalogLoadState).toBe('error');

  act(() => useSessionStore.getState().retryCatalog());
  const retryOptions = mockUseSSEStream.mock.calls.at(-1)?.[0] as {
    connectionKey: string;
    onEvent: (type: string, data: unknown, id?: string) => void;
  };
  expect(retryOptions.connectionKey).not.toBe(firstOptions.connectionKey);
  expect(fetchMock).not.toHaveBeenCalled();

  act(() => {
    retryOptions.onEvent('stream_meta', { latest_id: 0, instance_id: 'node-a' }, '0');
    retryOptions.onEvent('session_list', {
      folders: [], sessions: [], total: 0, hasMore: false, nextCursor: null,
    }, '0');
  });

  expect(useSessionStore.getState().catalogLoadState).toBe('ready');
  expect(useSessionStore.getState().feedSessionIds).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
  hook.unmount();
});
