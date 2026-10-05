import { act, renderHook, waitFor } from '@testing-library/react-native';
import { createApiClient } from '../../api/client';
import type { Session } from '../../api/types';
import { useSessionStore } from '../../store/sessionStore';
import { useFeedPagination } from '../useFeedPagination';

const BASE = 'https://feed-page.test';

function session(id: string): Session {
  return {
    agentSessionId: id,
    displayName: id,
    status: 'running',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
  };
}

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

function seedFirstPage(hasMore = true, nextCursor: string | null = '30') {
  useSessionStore.getState().applyFeedSnapshot({
    folders: [],
    sessions: Array.from({ length: 30 }, (_, index) => session(`first-${index}`)),
    total: 411,
    hasMore,
    nextCursor,
  });
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

test('one end reach loads one 30-row page and does not continue to total', async () => {
  seedFirstPage();
  const incoming = Array.from({ length: 30 }, (_, index) => session(`next-${index}`));
  const fetchMock = jest.fn().mockResolvedValue(jsonResponse({
    sessions: incoming,
    total: 411,
    hasMore: true,
    nextCursor: '60',
  }));
  global.fetch = fetchMock;
  const { result } = renderHook(() => useFeedPagination(createApiClient(BASE)));

  await act(async () => { await result.current.loadMore(); });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe(
    `${BASE}/api/sessions?feed_only=true&feed_display=true&limit=30&cursor=30`,
  );
  expect(useSessionStore.getState().feedSessionIds).toHaveLength(60);
  expect(useSessionStore.getState().feedPage).toMatchObject({
    hasMore: true,
    nextCursor: '60',
    status: 'idle',
  });
});

test('a second end reach after the first page loads requests exactly the next page', async () => {
  seedFirstPage();
  const fetchMock = jest.fn()
    .mockResolvedValueOnce(jsonResponse({
      sessions: Array.from({ length: 30 }, (_, index) => session(`next-${index}`)),
      total: 411,
      hasMore: true,
      nextCursor: '60',
    }))
    .mockResolvedValueOnce(jsonResponse({
      sessions: Array.from({ length: 30 }, (_, index) => session(`last-${index}`)),
      total: 411,
      hasMore: true,
      nextCursor: '90',
    }));
  global.fetch = fetchMock;
  const { result } = renderHook(() => useFeedPagination(createApiClient(BASE)));

  await act(async () => { await result.current.loadMore(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { await result.current.loadMore(); });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get('cursor')))
    .toEqual(['30', '60']);
  expect(useSessionStore.getState().feedSessionIds).toHaveLength(90);
});

test('loading and error block end reach, while the error button retries one page', async () => {
  seedFirstPage();
  let resolveFirst!: (response: Response) => void;
  const fetchMock = jest.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(jsonResponse({ sessions: [], total: 411, hasMore: true, nextCursor: '60' }));
  global.fetch = fetchMock;
  const { result } = renderHook(() => useFeedPagination(createApiClient(BASE)));

  let loadingRequest!: Promise<void>;
  act(() => { loadingRequest = result.current.loadMore(); });
  await act(async () => { await result.current.loadMore(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveFirst(jsonResponse({ sessions: [], total: 411, hasMore: true, nextCursor: '60' }));
    await loadingRequest;
  });

  await act(async () => { await result.current.loadMore(); });
  expect(useSessionStore.getState().feedPage.status).toBe('error');
  const callsAfterFailure = fetchMock.mock.calls.length;
  await act(async () => { await result.current.loadMore(); });
  expect(fetchMock).toHaveBeenCalledTimes(callsAfterFailure);

  await act(async () => { await result.current.retryFeedPage(); });
  expect(fetchMock).toHaveBeenCalledTimes(callsAfterFailure + 1);
});

test('hasMore false or a missing cursor prevents another request', async () => {
  seedFirstPage(false, '30');
  const fetchMock = jest.fn();
  global.fetch = fetchMock;
  const { result } = renderHook(() => useFeedPagination(createApiClient(BASE)));

  await act(async () => { await result.current.loadMore(); });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(useSessionStore.getState().feedSessionIds).toHaveLength(30);
});

test('hasMore true without a cursor also prevents a request', async () => {
  seedFirstPage(true, null);
  const fetchMock = jest.fn();
  global.fetch = fetchMock;
  const { result } = renderHook(() => useFeedPagination(createApiClient(BASE)));

  await act(async () => { await result.current.loadMore(); });

  expect(fetchMock).not.toHaveBeenCalled();
});
