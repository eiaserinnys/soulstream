import { act, renderHook } from '@testing-library/react-native';
import { useSessionsStream } from '../useSessionsStream';

const callOrder: string[] = [];
const mockRefreshCard = jest.fn().mockResolvedValue(undefined);
var mockCardRows: Record<string, unknown>;
var mockCardDetails: Record<string, unknown>;
jest.mock('../../store/cardStore', () => ({
  refreshCard: (...args: unknown[]) => mockRefreshCard(...args),
  useCardStore: { getState: () => ({ rows: mockCardRows, details: mockCardDetails }) },
}));
const mockUpdateSession = jest.fn(() => callOrder.push('session-store'));
const mockInvalidatePlanner = jest.fn(() => callOrder.push('planner-invalidation'));
let capturedStreamOptions: any;
var mockUseSessionStore: jest.Mock & { getState: jest.Mock };

jest.mock('../../store/settingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: { serverUrl: string }) => unknown) => (
      selector({ serverUrl: 'https://soul.test' })
    ),
    {
      getState: () => ({ serverUrl: 'https://soul.test' }),
      subscribe: () => () => undefined,
    },
  ),
}));

jest.mock('../../store/authStore', () => ({
  useAuthStore: Object.assign(jest.fn(), {
    getState: () => ({ jwt: null, clear: jest.fn() }),
    subscribe: () => () => undefined,
  }),
}));

jest.mock('../../store/sessionStore', () => {
  const getState = () => ({
    catalogRetryRequest: 0,
    sessions: {
      'session-1': {
        agentSessionId: 'session-1',
        displayName: null,
        status: 'running',
        createdAt: '2026-07-17T00:00:00Z',
        updatedAt: '2026-07-17T00:00:00Z',
      },
    },
    catalog: { folders: [], sessions: {} },
    feedMembership: { 'session-1': 'candidate' },
    feedPage: { hasMore: false, nextCursor: null, status: 'idle' },
    updateSession: mockUpdateSession,
    upsertSession: jest.fn(),
    deleteSession: jest.fn(),
    setCatalog: jest.fn(),
    applyFeedSnapshot: jest.fn(),
    setSessions: jest.fn(),
    mergeSessions: jest.fn(),
    reconcileSessions: jest.fn(),
  });
  mockUseSessionStore = Object.assign(
    jest.fn((selector?: (state: ReturnType<typeof getState>) => unknown) => (
      typeof selector === 'function' ? selector(getState()) : getState()
    )),
    { getState: jest.fn(getState) },
  );
  return { useSessionStore: mockUseSessionStore };
});

jest.mock('../../store/plannerStore', () => ({
  usePlannerStore: {
    getState: () => ({ invalidate: mockInvalidatePlanner }),
  },
}));

jest.mock('../../api/client', () => ({
  createApiClient: () => ({
    getSessionsByIds: jest.fn(),
    catalogStreamUrl: () => 'https://soul.test/api/sessions/stream',
  }),
}));

jest.mock('../useSSEStream', () => ({
  CATALOG_STREAM_EVENTS: ['session_updated'],
  useSSEStream: (options: unknown) => {
    capturedStreamOptions = options;
  },
}));

beforeEach(() => {
  mockRefreshCard.mockClear();
  mockCardRows = {};
  mockCardDetails = {};
  callOrder.length = 0;
  mockUpdateSession.mockClear();
  mockInvalidatePlanner.mockClear();
});

test('session_updated는 sessionStore를 먼저 패치한 뒤 planner source에 전달한다', () => {
  renderHook(() => useSessionsStream());

  act(() => capturedStreamOptions.onEvent('session_updated', {
    agent_session_id: 'session-1',
    status: 'completed',
    updated_at: '2026-07-17T01:00:00Z',
  }));

  expect(mockUpdateSession).toHaveBeenCalledWith(
    'session-1',
    expect.objectContaining({ status: 'completed' }),
  );
  expect(mockInvalidatePlanner).toHaveBeenCalledWith('session_updated');
  expect(callOrder).toEqual(['session-store', 'planner-invalidation']);
});

test('stream_meta만으로 planner를 무효화하거나 복구를 시작하지 않는다', () => {
  renderHook(() => useSessionsStream());

  act(() => capturedStreamOptions.onEvent('stream_meta', {
    instance_id: 'instance-a',
    latest_id: 10,
  }));
  expect(mockInvalidatePlanner).not.toHaveBeenCalled();

  act(() => capturedStreamOptions.onEvent('stream_meta', {
    instance_id: 'instance-b',
    latest_id: 20,
  }));
  expect(mockInvalidatePlanner).not.toHaveBeenCalled();
});

test('page_updated는 version dedup 없이 수신마다 page source를 무효화한다', () => {
  renderHook(() => useSessionsStream());

  act(() => capturedStreamOptions.onEvent('page_updated', {
    page_id: 'page-1',
    version: 4,
  }));
  act(() => capturedStreamOptions.onEvent('page_updated', {
    page_id: 'page-1',
    version: 4,
  }));

  expect(mockInvalidatePlanner).toHaveBeenNthCalledWith(1, 'page');
  expect(mockInvalidatePlanner).toHaveBeenNthCalledWith(2, 'page');
});

test('card_updated는 표시 중인 카드의 상세를 재조회하고 card source를 무효화한다', async () => {
  mockCardRows = { 'card-1': { id: 'card-1' } };
  renderHook(() => useSessionsStream());
  await act(async () => capturedStreamOptions.onEvent('card_updated', { cardId: 'card-1', folderId: 'folder-1' }));
  expect(mockRefreshCard).toHaveBeenCalledTimes(1);
  expect(mockRefreshCard).toHaveBeenCalledWith(expect.any(Object), 'card-1');
  expect(mockInvalidatePlanner).toHaveBeenCalledTimes(1);
  expect(mockInvalidatePlanner).toHaveBeenCalledWith('card');
});

test('card_updated는 열린 상세의 카드도 재조회한다', async () => {
  mockCardDetails = { 'card-1': { card: { id: 'card-1' } } };
  renderHook(() => useSessionsStream());
  await act(async () => capturedStreamOptions.onEvent('card_updated', { cardId: 'card-1' }));
  expect(mockRefreshCard).toHaveBeenCalledTimes(1);
  expect(mockRefreshCard).toHaveBeenCalledWith(expect.any(Object), 'card-1');
});

test('card_updated는 목록에도 상세에도 없는 카드를 개별로 재조회하지 않고 목록 무효화만 한다', async () => {
  renderHook(() => useSessionsStream());
  await act(async () => capturedStreamOptions.onEvent('card_updated', { cardId: 'card-new', folderId: 'folder-1' }));
  expect(mockRefreshCard).not.toHaveBeenCalled();
  expect(mockInvalidatePlanner).toHaveBeenCalledTimes(1);
  expect(mockInvalidatePlanner).toHaveBeenCalledWith('card');
});
