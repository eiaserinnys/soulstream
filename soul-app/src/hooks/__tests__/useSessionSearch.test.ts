import { act, renderHook } from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import { useSessionSearch } from '../useSessionSearch';
import { useSearchStore } from '../../store/searchStore';
import { useSessionStore } from '../../store/sessionStore';
import {
  createUiUsageFlowId,
  recordUiUsageEvent,
} from '../../lib/ui-usage-events';

jest.mock('../../lib/ui-usage-events', () => ({
  createUiUsageFlowId: jest.fn(() => 'search-flow'),
  recordUiUsageEvent: jest.fn(),
}));

function session(id: string, folderId?: string) {
  return {
    agentSessionId: id,
    displayName: id,
    status: 'completed',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...(folderId ? { folderId } : {}),
  };
}

function apiMock() {
  return {
    searchSessions: jest.fn().mockResolvedValue({
      sessions: [session('meta-1')],
      total: 1,
      hasMore: false,
      nextCursor: null,
    }),
    searchSessionMessages: jest.fn().mockResolvedValue({
      results: [{
        sessionId: 'body-1',
        eventId: 7,
        eventType: 'assistant_message',
        preview: 'alpha preview',
        score: 1,
      }],
      navigationResults: [],
      sessionResults: [],
      searchStatus: null,
    }),
    getSessionsByIds: jest.fn().mockResolvedValue([session('body-1')]),
  } as unknown as ApiClient;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  useSearchStore.getState().reset();
  useSessionStore.setState({
    sessions: {},
    catalog: { folders: [], sessions: {} },
    catalogReady: true,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

test('300ms 뒤 lexical session projection을 먼저 요청하고 세션 수화는 화면을 막지 않는다', async () => {
  const api = apiMock();
  useSearchStore.getState().setFilters({
    includeTurnSummaries: true,
    includeHighlight: true,
    includeStory: true,
  });
  useSearchStore.getState().setQuery('alpha');
  const { result } = renderHook(() => useSessionSearch(api));

  await act(async () => {
    jest.advanceTimersByTime(299);
  });
  expect(api.searchSessions).not.toHaveBeenCalled();

  await act(async () => {
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(api.searchSessions).not.toHaveBeenCalled();
  expect(api.searchSessionMessages).toHaveBeenNthCalledWith(1,
    expect.objectContaining({
      query: 'alpha',
      topK: 20,
      includeTurnSummaries: true,
      includeHighlight: true,
      includeStory: true,
      includeSessionResults: true,
      sessionSearchMode: 'lexical',
    }),
    expect.any(AbortSignal),
  );
  expect(api.searchSessionMessages).toHaveBeenNthCalledWith(2,
    expect.objectContaining({ query: 'alpha', sessionSearchMode: 'expanded' }),
    expect.any(AbortSignal),
  );
  expect(api.getSessionsByIds).toHaveBeenCalledWith(['body-1'], expect.any(AbortSignal));
  expect(result.current.sessionResults.map((item) => item.agentSessionId))
    .toEqual([]);
  expect(result.current.messageResults).toHaveLength(1);
  expect(Object.keys(useSessionStore.getState().sessions)).toContain('body-1');
});

test('session projection is immediate, hydrates in the background, and removes its duplicate event row', async () => {
  const api = apiMock();
  (api.searchSessionMessages as jest.Mock).mockResolvedValue({
    results: [{
      sessionId: 'body-1',
      eventId: 7,
      eventType: 'assistant_message',
      preview: 'duplicate excerpt',
      score: 1,
    }, {
      sessionId: 'body-2',
      eventId: 8,
      eventType: 'assistant_message',
      preview: 'other event',
      score: 0.8,
    }],
    navigationResults: [],
    sessionResults: [{
      sessionId: 'body-1',
      title: 'body-1',
      excerpt: 'matching session',
      updatedAt: null,
      folderId: null,
      nodeId: null,
      status: null,
      backend: null,
      parentSessionId: null,
      bestMatch: {
        eventId: 7,
        matchSource: 'message',
        excerpt: 'duplicate excerpt',
      },
      sessionUrl: '/?session=body-1&event=7',
    }],
    searchStatus: {
      queryExpansion: { status: 'partial', reason: 'timeout', latencyMs: 3000 },
      searchLatencyMs: 4900,
      dbCancelFailed: false,
    },
  });
  (api.getSessionsByIds as jest.Mock).mockResolvedValue([
    session('body-1'),
    session('body-2'),
  ]);
  useSearchStore.getState().setQuery('alpha');
  const { result } = renderHook(() => useSessionSearch(api));

  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(api.getSessionsByIds).toHaveBeenCalledWith(
    ['body-1', 'body-2'],
    expect.any(AbortSignal),
  );
  expect(result.current.sessionMatches.map((match) => match.sessionId))
    .toEqual(['body-1']);
  expect(result.current.searchStatus).toMatchObject({
    queryExpansion: { status: 'partial', reason: 'timeout' },
  });
  expect(result.current.messageResults.map((match) => match.sessionId))
    .toEqual(['body-2']);
});

test('실제 검색 요청 하나를 flowId로 짝짓고 입력 원문을 보존한다', async () => {
  const api = apiMock();
  useSearchStore.getState().setQuery('  alpha  ');
  const { result } = renderHook(() => useSessionSearch(api));

  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(createUiUsageFlowId).toHaveBeenCalledTimes(1);
  expect(recordUiUsageEvent).toHaveBeenCalledWith({
    type: 'search_submit',
    flowId: 'search-flow',
    attrs: { queryText: '  alpha  ', trigger: 'typing', scope: 'all' },
  });
  expect(recordUiUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
    type: 'search_result',
    flowId: 'search-flow',
    attrs: expect.objectContaining({ status: 'ok', resultCount: 1 }),
  }));
  expect(result.current.searchFlowId).toBe('search-flow');
});

test('쿼리가 바뀌면 lexical과 expanded 요청을 abort하고 늦은 결과를 버린다', async () => {
  const api = apiMock();
  let resolveMessages!: (value: {
    results: never[];
    navigationResults: never[];
    sessionResults: never[];
    searchStatus: null;
  }) => void;
  (api.searchSessionMessages as jest.Mock).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveMessages = resolve;
    }),
  );
  useSearchStore.getState().setQuery('first');
  const { rerender } = renderHook(() => useSessionSearch(api));

  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  const firstSignal = (api.searchSessionMessages as jest.Mock).mock.calls[0][1] as AbortSignal;
  expect(firstSignal.aborted).toBe(false);

  act(() => {
    useSearchStore.getState().setQuery('second');
    rerender({});
  });
  expect(firstSignal.aborted).toBe(true);

  await act(async () => {
    resolveMessages({ results: [], navigationResults: [], sessionResults: [], searchStatus: null });
    await Promise.resolve();
  });
});

test('본문 결과가 없으면 빈 세션 수화 요청을 만들지 않는다', async () => {
  const api = apiMock();
  (api.searchSessionMessages as jest.Mock).mockResolvedValue({
    results: [],
    navigationResults: [],
    sessionResults: [],
    searchStatus: null,
  });
  useSearchStore.getState().setQuery('missing');
  renderHook(() => useSessionSearch(api));

  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(api.getSessionsByIds).not.toHaveBeenCalled();
});

test('의역 확장 중에도 lexical projection이 보이고 실패해도 유지한다', async () => {
  const api = apiMock();
  let rejectExpanded!: (error: Error) => void;
  (api.searchSessionMessages as jest.Mock)
    .mockResolvedValueOnce({
      results: [],
      navigationResults: [],
      sessionResults: [{
        sessionId: 'lexical-session',
        title: 'Different title',
        excerpt: 'Lexical excerpt',
        updatedAt: null,
        folderId: null,
        nodeId: null,
        status: null,
        backend: null,
        folderTitle: null,
        parentSessionId: null,
        bestMatch: { eventId: 19, matchSource: 'session_title', excerpt: 'Lexical excerpt' },
        sessionUrl: '/?session=lexical-session&event=19',
      }],
      searchStatus: { queryExpansion: { status: 'skipped', latencyMs: 0 }, searchLatencyMs: 110, dbCancelFailed: false },
    })
    .mockReturnValueOnce(new Promise((_, reject) => { rejectExpanded = reject; }));
  useSearchStore.getState().setQuery('a paraphrase');
  const { result } = renderHook(() => useSessionSearch(api));

  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(result.current.sessionMatches.map((match) => match.sessionId)).toEqual(['lexical-session']);
  expect(result.current.loading).toBe(false);
  expect(result.current.expansionPending).toBe(true);
  expect(api.searchSessionMessages).toHaveBeenCalledTimes(2);
  expect((api.searchSessionMessages as jest.Mock).mock.calls[1][0])
    .toMatchObject({ sessionSearchMode: 'expanded' });

  await act(async () => {
    rejectExpanded(new Error('semantic timeout'));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(result.current.sessionMatches.map((match) => match.sessionId)).toEqual(['lexical-session']);
  expect(result.current.expansionPending).toBe(false);
  expect(result.current.expansionFailed).toBe(true);
  expect(result.current.error).toBeNull();
});

test('expanded HTTP 성공이 partial이면 lexical 결과를 유지한다', async () => {
  const api = apiMock();
  (api.searchSessionMessages as jest.Mock)
    .mockResolvedValueOnce({
      results: [],
      navigationResults: [],
      sessionResults: [{
        sessionId: 'lexical-session',
        title: 'Different title',
        excerpt: 'Lexical excerpt',
        updatedAt: null,
        folderId: null,
        nodeId: null,
        status: null,
        backend: null,
        folderTitle: null,
        parentSessionId: null,
        bestMatch: { eventId: 19, matchSource: 'initial_request', excerpt: 'Lexical excerpt' },
        sessionUrl: '/?session=lexical-session&event=19',
      }],
      searchStatus: { queryExpansion: { status: 'skipped', latencyMs: 0 }, searchLatencyMs: 110, dbCancelFailed: false },
    })
    .mockResolvedValueOnce({
      results: [],
      navigationResults: [],
      sessionResults: [{
        sessionId: 'partial-replacement',
        title: '부분 응답',
        excerpt: '',
        updatedAt: null,
        folderId: null,
        nodeId: null,
        status: null,
        backend: null,
        folderTitle: null,
        parentSessionId: null,
        bestMatch: { eventId: 20, matchSource: 'assistant_message', excerpt: '' },
        sessionUrl: '/?session=partial-replacement&event=20',
      }],
      searchStatus: {
        queryExpansion: { status: 'partial', reason: 'timeout', latencyMs: 4500 },
        searchLatencyMs: 4500,
        dbCancelFailed: false,
      },
    });
  useSearchStore.getState().setQuery('a paraphrase');
  const { result } = renderHook(() => useSessionSearch(api));

  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(result.current.sessionMatches.map((match) => match.sessionId)).toEqual(['lexical-session']);
  expect(result.current.expansionFailed).toBe(true);
  expect(result.current.expansionPending).toBe(false);
  expect(result.current.messageLoading).toBe(false);
});

test('expanded projection은 갱신하되 기존 세션 event anchor를 유지한다', async () => {
  const api = apiMock();
  (api.searchSessionMessages as jest.Mock)
    .mockResolvedValueOnce({
      results: [],
      navigationResults: [],
      sessionResults: [{
        sessionId: 'same-session',
        title: '다른 제목',
        excerpt: 'lexical excerpt',
        updatedAt: null,
        folderId: null,
        nodeId: null,
        status: null,
        backend: null,
        folderTitle: null,
        parentSessionId: null,
        bestMatch: { eventId: 11, matchSource: 'message', excerpt: 'lexical excerpt' },
        sessionUrl: '/?session=same-session&event=11',
      }],
      searchStatus: null,
    })
    .mockResolvedValueOnce({
      results: [],
      navigationResults: [],
      sessionResults: [{
        sessionId: 'same-session',
        title: '의미 결과 제목',
        excerpt: 'expanded excerpt',
        updatedAt: null,
        folderId: null,
        nodeId: null,
        status: null,
        backend: null,
        folderTitle: null,
        parentSessionId: null,
        bestMatch: { eventId: 22, matchSource: 'assistant_message', excerpt: 'expanded excerpt' },
        sessionUrl: '/?session=same-session&event=22',
      }],
      searchStatus: null,
    });
  useSearchStore.getState().setQuery('의역 질의');
  const { result } = renderHook(() => useSessionSearch(api));

  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(result.current.sessionMatches).toMatchObject([{
    sessionId: 'same-session',
    title: '의미 결과 제목',
    bestMatch: { eventId: 11, matchSource: 'message' },
    sessionUrl: '/?session=same-session&event=11',
  }]);
});

test('정규화한 제목이 정확히 일치할 때만 expanded 후속을 생략한다', async () => {
  const api = apiMock();
  (api.searchSessionMessages as jest.Mock).mockResolvedValue({
    results: [],
    navigationResults: [],
    sessionResults: [{
      sessionId: 'exact-title',
      title: '피드 검색',
      excerpt: '',
      updatedAt: null,
      folderId: null,
      nodeId: null,
      status: null,
      backend: null,
      parentSessionId: null,
      bestMatch: { eventId: null, matchSource: 'session_title', excerpt: '' },
      sessionUrl: '/?session=exact-title',
    }],
    searchStatus: null,
  });
  useSearchStore.getState().setQuery('피드·검색');
  const { result } = renderHook(() => useSessionSearch(api));

  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(api.searchSessionMessages).toHaveBeenCalledTimes(1);
  expect(result.current.sessionMatches[0]?.sessionId).toBe('exact-title');
  expect(result.current.expansionPending).toBe(false);
});

test('server filters reach both modes and unresolved session hydration cannot block lexical or expanded rows', async () => {
  const api = apiMock();
  let resolveHydration!: (sessions: ReturnType<typeof session>[]) => void;
  let resolveExpanded!: (payload: Awaited<ReturnType<ApiClient['searchSessionMessages']>>) => void;
  (api.getSessionsByIds as jest.Mock).mockReturnValue(new Promise((resolve) => {
    resolveHydration = resolve;
  }));
  (api.searchSessionMessages as jest.Mock)
    .mockResolvedValueOnce({
      results: [],
      navigationResults: [],
      sessionResults: [{
        sessionId: 'lexical-filtered',
        title: '실제 요청 결과',
        excerpt: '',
        folderId: 'folder-a',
        nodeId: 'node-a',
        status: 'completed',
        backend: 'codex',
        updatedAt: '2026-09-22T12:00:00.000Z',
        folderTitle: null,
        parentSessionId: null,
        bestMatch: { eventId: null, matchSource: 'initial_request', excerpt: '' },
        sessionUrl: '/?session=lexical-filtered',
      }],
      searchStatus: null,
    })
    .mockReturnValueOnce(new Promise((resolve) => { resolveExpanded = resolve; }));
  useSearchStore.getState().setFilters({
    folderId: 'folder-a',
    nodeId: 'node-a',
    statuses: ['completed'],
    backends: ['codex'],
    period: '7d',
  });
  useSearchStore.getState().setQuery('예전 대화를 찾아 이어서 작업');
  const { result } = renderHook(() => useSessionSearch(api));

  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(api.searchSessionMessages).toHaveBeenCalledTimes(2);
  const lexicalFilters = (api.searchSessionMessages as jest.Mock).mock.calls[0][0].sessionFilters;
  expect(lexicalFilters).toMatchObject({
    folderId: 'folder-a',
    nodeId: 'node-a',
    statuses: ['completed'],
    backends: ['codex'],
  });
  expect(lexicalFilters.updatedAfter).toEqual(expect.any(String));
  expect((api.searchSessionMessages as jest.Mock).mock.calls[1][0].sessionFilters)
    .toEqual(lexicalFilters);
  expect(result.current.expansionPending).toBe(true);
  expect(result.current.messageLoading).toBe(false);
  expect(result.current.sessionMatches.map((match) => match.sessionId))
    .toEqual(['lexical-filtered']);

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(result.current.sessionMatches.map((match) => match.sessionId))
    .toEqual(['lexical-filtered']);
  expect(result.current.expansionPending).toBe(true);

  await act(async () => {
    resolveExpanded({
      results: [],
      navigationResults: [],
      sessionResults: [{
        sessionId: 'expanded-filtered',
        title: '확장 결과',
        excerpt: '',
        folderId: 'folder-a',
        nodeId: 'node-a',
        status: 'completed',
        backend: 'codex',
        updatedAt: '2026-09-22T12:00:00.000Z',
        folderTitle: null,
        parentSessionId: null,
        bestMatch: { eventId: null, matchSource: 'session_title', excerpt: '' },
        sessionUrl: '/?session=expanded-filtered',
      }],
      searchStatus: null,
    });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(result.current.sessionMatches.map((match) => match.sessionId))
    .toEqual(['expanded-filtered']);
  expect(result.current.expansionPending).toBe(false);

  await act(async () => {
    resolveHydration([session('lexical-filtered', 'folder-a')]);
    await Promise.resolve();
    await Promise.resolve();
  });
});
