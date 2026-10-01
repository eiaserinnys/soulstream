import { renderHook, act, waitFor } from '@testing-library/react-native';

let mockConsoleWarn: jest.SpyInstance;

// authStore stub — useSSEStream의 connect()가 jwt를 읽음.
jest.mock('../../store/authStore', () => ({
  useAuthStore: Object.assign(jest.fn(), {
    getState: () => ({ jwt: null, clear: jest.fn() }),
    subscribe: () => () => undefined,
  }),
}));

// settingsStore mock — persist 미들웨어 의존을 피하기 위해 단순 selector 함수로 대체.
// useSettingsStore((s) => s.serverUrl) 형태만 useSessionsStream에서 호출되므로 충분.
const mockServerUrl = 'https://server.test';
jest.mock('../../store/settingsStore', () => ({
  useSettingsStore: Object.assign(
    <T,>(selector: (s: { serverUrl: string }) => T): T =>
      selector({ serverUrl: mockServerUrl }),
    {
      getState: () => ({ serverUrl: mockServerUrl }),
      subscribe: () => () => undefined,
    },
  ),
}));

// sessionStore mock — useSessionsStream은 렌더 구독 없이 getState()에서 action을 꺼낸다.
// hook 호출이 남아 있으면 subscription boundary 테스트가 실패한다.
const mockSessionStoreActions = {
  sessions: {} as Record<string, any>,
  catalog: { folders: [], sessions: {} } as any,
  catalogReady: false,
  catalogLoadState: 'loading' as 'loading' | 'ready' | 'error',
  catalogRetryRequest: 0,
  setSessions: jest.fn(),
  upsertSession: jest.fn(),
  updateSession: jest.fn(),
  applyPendingAttentionsDelta: jest.fn(),
  deleteSession: jest.fn(),
  setFeedCatalogSnapshot: jest.fn(),
  applyCatalogDelta: jest.fn(),
  mergeSessions: jest.fn(),
  reconcileSessions: jest.fn(),
  markCatalogLoadFailed: jest.fn(),
  retryCatalog: jest.fn(),
};
var mockUseSessionStore: jest.Mock & { getState: jest.Mock };
jest.mock('../../store/sessionStore', () => ({
  useSessionStore: (() => {
    mockUseSessionStore = jest.fn((selector?: any) =>
      typeof selector === 'function'
        ? selector(mockSessionStoreActions)
        : mockSessionStoreActions,
    ) as jest.Mock & { getState: jest.Mock };
    mockUseSessionStore.getState = jest.fn(() => mockSessionStoreActions);
    return mockUseSessionStore;
  })(),
}));

// createApiClient mock — getCatalog와 catalogStreamUrl만 검증 대상.
const mockGetCatalog = jest.fn();
const mockCatalogStreamUrl = jest.fn(
  (
    lastEventId?: string,
    instanceId?: string,
    scope?: { feedOnly?: boolean },
  ) => {
    const params = new URLSearchParams();
    if (scope?.feedOnly) params.set('feed_only', 'true');
    if (lastEventId) params.set('lastEventId', lastEventId);
    if (instanceId) params.set('instanceId', instanceId);
    const qs = params.toString();
    return `${mockServerUrl}/api/sessions/stream${qs ? `?${qs}` : ''}`;
  },
);

// orch-server의 feed_only snapshot과 catalog_updated delta가 앱에 도착한 실제 wire 모양.
// feed_only snapshot에는 제외된 상세 세션의 assignment/sessionList가 없다.
const feedOnlyCatalogWire = {
  folders: [
    { id: 'visible', name: 'Visible', sortOrder: 0 },
    {
      id: 'excluded',
      name: 'Excluded',
      sortOrder: 1,
      settings: { excludeFromFeed: true },
    },
  ],
  sessions: {
    visible: { folderId: 'visible', displayName: 'Visible' },
  },
  sessionList: [
    {
      agentSessionId: 'visible',
      displayName: 'Visible',
      status: 'running',
      createdAt: '2026-09-22T00:00:00Z',
      updatedAt: '2026-09-22T00:00:00Z',
      folderId: 'visible',
    },
  ],
};

const excludedCatalogDeltaWire = {
  type: 'catalog_updated',
  folders: feedOnlyCatalogWire.folders,
  sessions_delta: { 'open-detail': null },
  board_items_delta: {},
};
jest.mock('../../api/client', () => ({
  createApiClient: () => ({
    getCatalog: mockGetCatalog,
    catalogStreamUrl: mockCatalogStreamUrl,
  }),
}));

declare global {
  // eslint-disable-next-line no-var
  var __lastSSEInstance: any;
}

import { useSessionsStream } from '../useSessionsStream';

beforeEach(() => {
  mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockSessionStoreActions.sessions = {};
  mockSessionStoreActions.catalog = { folders: [], sessions: {} };
  mockSessionStoreActions.catalogReady = false;
  mockSessionStoreActions.catalogLoadState = 'loading';
  mockSessionStoreActions.catalogRetryRequest = 0;
  Object.values(mockSessionStoreActions).forEach((value) => {
    if (typeof value === 'function') value.mockClear();
  });
  mockSessionStoreActions.setSessions.mockImplementation((sessions: any[]) => {
    mockSessionStoreActions.sessions = Object.fromEntries(
      sessions.map((session) => [session.agentSessionId, session]),
    );
  });
  mockSessionStoreActions.upsertSession.mockImplementation((session: any) => {
    mockSessionStoreActions.sessions[session.agentSessionId] = {
      ...mockSessionStoreActions.sessions[session.agentSessionId],
      ...session,
    };
  });
  mockSessionStoreActions.mergeSessions.mockImplementation((sessions: any[]) => {
    for (const session of sessions) {
      mockSessionStoreActions.sessions[session.agentSessionId] = {
        ...mockSessionStoreActions.sessions[session.agentSessionId],
        ...session,
      };
    }
  });
  mockSessionStoreActions.reconcileSessions.mockImplementation((validIds: Set<string>) => {
    for (const sessionId of Object.keys(mockSessionStoreActions.sessions)) {
      if (!validIds.has(sessionId)) delete mockSessionStoreActions.sessions[sessionId];
    }
  });
  mockSessionStoreActions.updateSession.mockImplementation(
    (sessionId: string, updates: Record<string, unknown>) => {
      if (!mockSessionStoreActions.sessions[sessionId]) return;
      mockSessionStoreActions.sessions[sessionId] = {
        ...mockSessionStoreActions.sessions[sessionId],
        ...updates,
      };
    },
  );
  mockSessionStoreActions.deleteSession.mockImplementation((sessionId: string) => {
    delete mockSessionStoreActions.sessions[sessionId];
  });
  mockSessionStoreActions.setFeedCatalogSnapshot.mockImplementation((catalog: any) => {
    mockSessionStoreActions.catalog = catalog;
    mockSessionStoreActions.catalogReady = true;
    mockSessionStoreActions.catalogLoadState = 'ready';
  });
  mockSessionStoreActions.applyCatalogDelta.mockImplementation(
    (folders: any[], sessionsDelta: Record<string, any | null>) => {
      let sessions = mockSessionStoreActions.catalog.sessions;
      for (const [sessionId, assignment] of Object.entries(sessionsDelta)) {
        if (assignment === null) {
          if (!(sessionId in sessions)) continue;
          if (sessions === mockSessionStoreActions.catalog.sessions) {
            sessions = { ...sessions };
          }
          delete sessions[sessionId];
          continue;
        }
        if (sessions === mockSessionStoreActions.catalog.sessions) {
          sessions = { ...sessions };
        }
        sessions[sessionId] = assignment;
      }
      mockSessionStoreActions.catalog = { folders, sessions };
      mockSessionStoreActions.catalogReady = true;
      mockSessionStoreActions.catalogLoadState = 'ready';
    },
  );
  mockUseSessionStore.mockClear();
  mockUseSessionStore.getState.mockClear();
  mockGetCatalog.mockReset();
  mockCatalogStreamUrl.mockClear();
  delete globalThis.__lastSSEInstance;
});

afterEach(() => {
  mockConsoleWarn.mockRestore();
});

describe('useSessionsStream — store subscription boundary', () => {
  test('session store에는 명시 재시도 신호만 구독하고 mutation은 getState로 수행한다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: { 'sess-1': { folderId: null, displayName: '기존 세션' } },
      sessionList: [
        {
          agentSessionId: 'sess-1',
          displayName: '기존 세션',
          status: 'idle',
          createdAt: '2026-05-16T02:00:00Z',
          updatedAt: '2026-05-16T02:00:00Z',
        },
      ],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockUseSessionStore).toHaveBeenCalled();
    expect(mockUseSessionStore.mock.calls[0][0](mockSessionStoreActions)).toBe(0);
    expect(mockUseSessionStore.getState).toHaveBeenCalled();
  });

  test('초기 catalog fetch는 feed 전용 전체 snapshot을 요청한다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: { 'sess-1': { folderId: null, displayName: '기존 세션' } },
      sessionList: [
        {
          agentSessionId: 'sess-1',
          displayName: '기존 세션',
          status: 'idle',
          createdAt: '2026-05-16T02:00:00Z',
          updatedAt: '2026-05-16T02:00:00Z',
        },
      ],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetCatalog).toHaveBeenCalledWith(
      {
        feed_only: true,
        limit: 0,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  test('명시 재시도 신호는 REST snapshot과 SSE를 각각 한 번 새로 시작한다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: {},
      sessionList: [],
    });

    const { rerender } = renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });
    const firstSse = globalThis.__lastSSEInstance;

    mockSessionStoreActions.catalogRetryRequest = 1;
    rerender(undefined);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetCatalog).toHaveBeenCalledTimes(2);
    expect(globalThis.__lastSSEInstance).not.toBe(firstSse);
  });

  test('unmount는 진행 중인 initial catalog request를 abort하고 오류 상태를 남기지 않는다', async () => {
    let rejectCatalog!: (error: Error) => void;
    mockGetCatalog.mockImplementation(
      () => new Promise((_resolve, reject) => {
        rejectCatalog = reject;
      }),
    );

    const { unmount } = renderHook(() => useSessionsStream());
    const request = mockGetCatalog.mock.calls[0][1] as { signal: AbortSignal };
    unmount();

    expect(request.signal.aborted).toBe(true);
    await act(async () => {
      rejectCatalog(new Error('aborted'));
      await Promise.resolve();
    });
    expect(mockSessionStoreActions.markCatalogLoadFailed).not.toHaveBeenCalled();
  });

  test('초기 feed snapshot에 제외 폴더 세션이 섞여도 store mergeSessions 전 걸러낸다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [
        { id: 'visible', name: 'Visible', sortOrder: 0 },
        {
          id: 'hidden',
          name: 'Hidden',
          sortOrder: 1,
          settings: { excludeFromFeed: true },
        },
      ],
      sessions: {
        visible: { folderId: 'visible', displayName: null },
        hidden: { folderId: 'hidden', displayName: null },
      },
      sessionList: [
        {
          agentSessionId: 'hidden',
          displayName: 'Hidden',
          status: 'idle',
          createdAt: '2026-05-16T02:00:00Z',
          updatedAt: '2026-05-16T02:00:00Z',
          folderId: 'hidden',
        },
        {
          agentSessionId: 'visible',
          displayName: 'Visible',
          status: 'idle',
          createdAt: '2026-05-16T02:00:00Z',
          updatedAt: '2026-05-16T02:00:00Z',
          folderId: 'visible',
        },
      ],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockSessionStoreActions.mergeSessions).toHaveBeenCalledWith([
      expect.objectContaining({ agentSessionId: 'visible' }),
    ]);
  });
});

describe('useSessionsStream — Last-Event-ID resume', () => {
  test('첫 stream_meta는 instanceId만 저장하고 lastEventId 점프·refetch는 하지 않는다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: { 'sess-1': { folderId: 'folder-a', displayName: '기존 세션' } },
      sessionList: [
        {
          agentSessionId: 'sess-1',
          displayName: '기존 세션',
          status: 'idle',
          createdAt: '2026-05-16T02:00:00Z',
          updatedAt: '2026-05-16T02:00:00Z',
          folderId: 'folder-a',
        },
      ],
    });

    renderHook(() => useSessionsStream());

    // 마운트 시 초기 catalog 페치 1회.
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);
    mockSessionStoreActions.setFeedCatalogSnapshot.mockClear();
    mockSessionStoreActions.mergeSessions.mockClear();

    // 첫 stream_meta 발화.
    const sse = globalThis.__lastSSEInstance;
    expect(sse).toBeDefined();
    sse.triggerEvent('stream_meta', { instance_id: 'inst-A', latest_id: 100 });

    // 첫 수신은 ref만 저장 → 추가 refetch(getCatalog) 발생하지 않음.
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);
    // setFeedCatalogSnapshot/mergeSessions도 추가 호출 없음.
    expect(mockSessionStoreActions.setFeedCatalogSnapshot).not.toHaveBeenCalled();
    expect(mockSessionStoreActions.mergeSessions).not.toHaveBeenCalled();
  });

  test('두 번째 stream_meta에서 instance_id가 바뀌면 refetch + lastEventId 점프', async () => {
    jest.useFakeTimers();
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: {},
      sessionList: [],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);

    const first = globalThis.__lastSSEInstance;
    first.triggerEvent('stream_meta', { instance_id: 'inst-A', latest_id: 100 });
    // 두 번째: 인스턴스가 바뀜 → refetch + 점프.
    first.triggerEvent('stream_meta', { instance_id: 'inst-B', latest_id: 250 });
    expect(mockGetCatalog).toHaveBeenCalledTimes(2);

    // 점프 좌표 검증: 다음 reconnect URL에 ?lastEventId=250 부착되는지.
    first.triggerError({ xhrStatus: 500 });
    jest.runOnlyPendingTimers();
    const second = globalThis.__lastSSEInstance;
    expect(second).not.toBe(first);
    expect(second.url).toBe(
      `${mockServerUrl}/api/sessions/stream?feed_only=true&lastEventId=250&instanceId=inst-B`,
    );
    jest.useRealTimers();
  });

  test('replay_gap 수신 시 refetch + lastEventId 점프', async () => {
    jest.useFakeTimers();
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: {},
      sessionList: [],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);

    const first = globalThis.__lastSSEInstance;
    // stream_meta 먼저 — instanceId ref 채움.
    first.triggerEvent('stream_meta', { instance_id: 'inst-A', latest_id: 100 });
    // replay_gap 발화.
    first.triggerEvent('replay_gap', { latest_id: 500, instance_id: 'inst-A' });
    expect(mockGetCatalog).toHaveBeenCalledTimes(2);
    expect(mockGetCatalog).toHaveBeenNthCalledWith(2, {
      feed_only: true,
      limit: 0,
    });

    // 점프 좌표 검증.
    first.triggerError({ xhrStatus: 500 });
    jest.runOnlyPendingTimers();
    const second = globalThis.__lastSSEInstance;
    expect(second.url).toBe(
      `${mockServerUrl}/api/sessions/stream?feed_only=true&lastEventId=500&instanceId=inst-A`,
    );
    jest.useRealTimers();
  });

  test('session_updated 수신 시 SSE id가 lastEventIdRef로 흐른다', async () => {
    jest.useFakeTimers();
    mockSessionStoreActions.sessions = {
      'sess-1': {
        agentSessionId: 'sess-1',
        displayName: '기존 세션',
        status: 'idle',
        createdAt: '2026-05-16T02:00:00Z',
        updatedAt: '2026-05-16T02:00:00Z',
      },
    };
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: { 'sess-1': { folderId: null, displayName: '기존 세션' } },
      sessionList: [
        {
          agentSessionId: 'sess-1',
          displayName: '기존 세션',
          status: 'idle',
          createdAt: '2026-05-16T02:00:00Z',
          updatedAt: '2026-05-16T02:00:00Z',
        },
      ],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    const first = globalThis.__lastSSEInstance;
    // SSE id 부착.
    first.triggerEvent(
      'session_updated',
      { agent_session_id: 'sess-1', status: 'running', last_event_id: 78 },
      '77',
    );
    expect(mockSessionStoreActions.updateSession).toHaveBeenCalledWith('sess-1', {
      status: 'running',
      lastEventId: 78,
    });

    // 재연결 URL에 lastEventId=77 부착되는지.
    first.triggerError({ xhrStatus: 500 });
    jest.runOnlyPendingTimers();
    const second = globalThis.__lastSSEInstance;
    expect(second.url).toBe(
      `${mockServerUrl}/api/sessions/stream?feed_only=true&lastEventId=77`,
    );
    jest.useRealTimers();
  });

  test.each([1, 5, 10])(
    'source-side no-op frame suppression reduces %i visible sessions from 3N frames/5N store commits to N/N',
    async (sessionCount) => {
      const sessionList = Array.from({ length: sessionCount }, (_, index) => ({
        agentSessionId: `sess-${index}`,
        displayName: `세션 ${index}`,
        status: 'running',
        createdAt: '2026-09-22T00:00:00Z',
        updatedAt: '2026-09-22T00:00:00Z',
        pendingAttentions: [],
        attentionRevision: 0,
      }));
      mockGetCatalog.mockResolvedValue({
        folders: [],
        sessions: Object.fromEntries(sessionList.map((session) => [
          session.agentSessionId,
          { folderId: null, displayName: session.displayName },
        ])),
        sessionList,
      });

      const { unmount } = renderHook(() => useSessionsStream());
      await act(async () => { await Promise.resolve(); });
      const sse = globalThis.__lastSSEInstance;
      mockSessionStoreActions.updateSession.mockClear();
      mockSessionStoreActions.applyPendingAttentionsDelta.mockClear();

      for (const [index, session] of sessionList.entries()) {
        const attentionDelta = {
          [`permission:tool-${index}`]: { revision: index + 1, value: null },
        };
        sse.triggerEvent('session_updated', {
          agent_session_id: session.agentSessionId,
          status: 'running',
          attention_revision: index + 1,
          pending_attentions_delta: attentionDelta,
        });
        sse.triggerEvent('session_updated', {
          agent_session_id: session.agentSessionId,
          status: 'running',
          attention_revision: index + 2,
          pending_attentions_delta: attentionDelta,
        });
        sse.triggerEvent('session_updated', {
          agent_session_id: session.agentSessionId,
          status: 'completed',
          last_event_id: 100 + index,
        });
      }
      const legacyFrames = sessionCount * 3;
      const legacyStoreCommits = mockSessionStoreActions.updateSession.mock.calls.length
        + mockSessionStoreActions.applyPendingAttentionsDelta.mock.calls.length;
      expect(legacyStoreCommits).toBe(sessionCount * 5);

      mockSessionStoreActions.updateSession.mockClear();
      mockSessionStoreActions.applyPendingAttentionsDelta.mockClear();
      for (const [index, session] of sessionList.entries()) {
        sse.triggerEvent('session_updated', {
          agent_session_id: session.agentSessionId,
          status: 'completed',
          last_event_id: 200 + index,
          feed_last_event_id: 200 + index,
        });
      }
      const semanticFrames = sessionCount;
      const semanticStoreCommits = mockSessionStoreActions.updateSession.mock.calls.length
        + mockSessionStoreActions.applyPendingAttentionsDelta.mock.calls.length;

      expect({ legacyFrames, legacyStoreCommits, semanticFrames, semanticStoreCommits })
        .toEqual({
          legacyFrames: sessionCount * 3,
          legacyStoreCommits: sessionCount * 5,
          semanticFrames: sessionCount,
          semanticStoreCommits: sessionCount,
        });
      expect(mockSessionStoreActions.updateSession).toHaveBeenLastCalledWith(
        `sess-${sessionCount - 1}`,
        expect.objectContaining({ feedLastEventId: 200 + sessionCount - 1 }),
      );
      unmount();
    },
  );

  test('session_updated store commit 실패 시 SSE cursor를 선반영하지 않는다', async () => {
    jest.useFakeTimers();
    mockSessionStoreActions.sessions = {
      'sess-1': {
        agentSessionId: 'sess-1',
        displayName: '기존 세션',
        status: 'idle',
        createdAt: '2026-05-16T02:00:00Z',
        updatedAt: '2026-05-16T02:00:00Z',
      },
    };
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: { 'sess-1': { folderId: null, displayName: '기존 세션' } },
      sessionList: [mockSessionStoreActions.sessions['sess-1']],
    });
    renderHook(() => useSessionsStream());
    await act(async () => { await Promise.resolve(); });

    const first = globalThis.__lastSSEInstance;
    mockSessionStoreActions.updateSession.mockImplementationOnce(() => {
      throw new Error('catalog store commit failed');
    });
    first.triggerEvent(
      'session_updated',
      { agent_session_id: 'sess-1', status: 'running' },
      '77',
    );

    expect(first.closed).toBe(true);
    jest.runOnlyPendingTimers();
    expect(globalThis.__lastSSEInstance.url).toBe(
      `${mockServerUrl}/api/sessions/stream?feed_only=true`,
    );
    jest.useRealTimers();
  });

  test('session_updated text_delta는 preview를 갱신하지 않고 updatedAt은 일반 메타로 전달한다', async () => {
    mockSessionStoreActions.sessions = {
      'sess-1': {
        agentSessionId: 'sess-1',
        displayName: '기존 세션',
        status: 'idle',
        createdAt: '2026-05-16T02:00:00Z',
        updatedAt: '2026-05-16T02:00:00Z',
      },
    };
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: { 'sess-1': { folderId: null, displayName: '기존 세션' } },
      sessionList: [
        {
          agentSessionId: 'sess-1',
          displayName: '기존 세션',
          status: 'idle',
          createdAt: '2026-05-16T02:00:00Z',
          updatedAt: '2026-05-16T02:00:00Z',
        },
      ],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    const first = globalThis.__lastSSEInstance;
    first.triggerEvent(
      'session_updated',
      {
        agent_session_id: 'sess-1',
        status: 'running',
        updated_at: '2026-05-16T03:00:01Z',
        last_message: {
          type: 'text_delta',
          preview: '스트리밍 중',
          timestamp: '2026-05-16T03:00:01Z',
        },
      },
      '78',
    );

    expect(mockSessionStoreActions.updateSession).toHaveBeenCalledWith('sess-1', {
      status: 'running',
      updatedAt: '2026-05-16T03:00:01Z',
    });
  });

  test('session_updated review delta는 기존 status와 독립된 cache patch로 전달한다', async () => {
    mockSessionStoreActions.sessions = {
      'sess-1': {
        agentSessionId: 'sess-1',
        displayName: '검수 세션',
        status: 'completed',
        createdAt: '2026-05-16T02:00:00Z',
        updatedAt: '2026-05-16T02:00:00Z',
        reviewRequired: true,
        reviewState: 'not_required',
      },
    };
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: { 'sess-1': { folderId: null, displayName: '검수 세션' } },
      sessionList: [mockSessionStoreActions.sessions['sess-1']],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    globalThis.__lastSSEInstance.triggerEvent('session_updated', {
      agent_session_id: 'sess-1',
      review_required: true,
      review_state: 'needs_review',
    });

    expect(mockSessionStoreActions.updateSession).toHaveBeenCalledWith('sess-1', {
      reviewRequired: true,
      reviewState: 'needs_review',
    });
  });

  test('session_updated의 exact pending_attentions_delta를 기존 단일 catalog stream에서 적용한다', async () => {
    mockSessionStoreActions.sessions = {
      'sess-1': {
        agentSessionId: 'sess-1',
        displayName: '응답 세션',
        status: 'running',
        createdAt: '2026-08-06T00:00:00Z',
        updatedAt: '2026-08-06T00:00:00Z',
        pendingAttentions: [],
        attentionRevision: 1000,
      },
    };
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: { 'sess-1': { folderId: null, displayName: '응답 세션' } },
      sessionList: [mockSessionStoreActions.sessions['sess-1']],
    });
    renderHook(() => useSessionsStream());
    await act(async () => { await Promise.resolve(); });

    const delta = {
      'input_request:req-7': {
        revision: 1001,
        value: {
          id: 'input_request:req-7',
          sourceEventId: 1001,
          sessionId: 'sess-1',
          kind: 'input_request',
          requestedAt: '2026-08-06T00:00:02Z',
          title: '입력 요청',
          body: '배포할까요?',
          requestId: 'req-7',
          requiresDetail: true,
        },
      },
    };
    globalThis.__lastSSEInstance.triggerEvent('session_updated', {
      agent_session_id: 'sess-1',
      attention_revision: 1001,
      pending_attentions_delta: delta,
    });

    expect(mockSessionStoreActions.applyPendingAttentionsDelta)
      .toHaveBeenCalledWith('sess-1', delta, 1001);
    expect(mockCatalogStreamUrl).toHaveBeenCalledWith(undefined, undefined, {
      feedOnly: true,
    });
  });

  test('initial REST와 경합한 attention delta는 snapshot 뒤 같은 wire로 재적용된다', async () => {
    let resolveCatalog!: (value: any) => void;
    mockGetCatalog.mockReturnValue(new Promise((resolve) => {
      resolveCatalog = resolve;
    }));
    renderHook(() => useSessionsStream());
    const delta = {
      'input_request:req-7': { revision: 1002, value: null },
    };

    globalThis.__lastSSEInstance.triggerEvent('session_updated', {
      agent_session_id: 'sess-1',
      attention_revision: 1002,
      pending_attentions_delta: delta,
    });
    expect(mockSessionStoreActions.applyPendingAttentionsDelta).not.toHaveBeenCalled();

    await act(async () => {
      resolveCatalog({
        folders: [],
        sessions: { 'sess-1': { folderId: null, displayName: '응답 세션' } },
        sessionList: [{
          agentSessionId: 'sess-1',
          displayName: '응답 세션',
          status: 'running',
          createdAt: '2026-08-06T00:00:00Z',
          updatedAt: '2026-08-06T00:00:00Z',
          pendingAttentions: [],
          attentionRevision: 1001,
        }],
      });
      await Promise.resolve();
    });

    expect(mockSessionStoreActions.applyPendingAttentionsDelta)
      .toHaveBeenCalledWith('sess-1', delta, 1002);
  });

  test('store에 없던 세션도 updated_at을 포함한 attention update면 생성 직후 delta를 적용한다', async () => {
    mockGetCatalog.mockResolvedValue({ folders: [], sessions: {}, sessionList: [] });
    renderHook(() => useSessionsStream());
    await act(async () => { await Promise.resolve(); });
    const delta = {
      'input_request:req-new': {
        revision: 2001,
        value: {
          id: 'input_request:req-new',
          sourceEventId: 2001,
          sessionId: 'sess-new-attention',
          kind: 'input_request',
          requestedAt: '2026-08-06T00:00:02Z',
          title: '입력 요청',
          body: '확인할까요?',
          requiresDetail: false,
        },
      },
    };

    globalThis.__lastSSEInstance.triggerEvent('session_updated', {
      agent_session_id: 'sess-new-attention',
      updated_at: '2026-08-06T00:00:02Z',
      attention_revision: 2001,
      pending_attentions_delta: delta,
    });

    expect(mockSessionStoreActions.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: 'sess-new-attention' }),
    );
    expect(mockSessionStoreActions.applyPendingAttentionsDelta)
      .toHaveBeenCalledWith('sess-new-attention', delta, 2001);
  });

  test('session_updated folderId null은 세션의 폴더 배정을 지운다', async () => {
    mockSessionStoreActions.sessions = {
      'sess-1': {
        agentSessionId: 'sess-1',
        displayName: '기존 세션',
        status: 'idle',
        createdAt: '2026-05-16T02:00:00Z',
        updatedAt: '2026-05-16T02:00:00Z',
      },
    };
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: { 'sess-1': { folderId: 'folder-a', displayName: '기존 세션' } },
      sessionList: [
        {
          agentSessionId: 'sess-1',
          displayName: '기존 세션',
          status: 'idle',
          createdAt: '2026-05-16T02:00:00Z',
          updatedAt: '2026-05-16T02:00:00Z',
          folderId: 'folder-a',
        },
      ],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    const first = globalThis.__lastSSEInstance;
    first.triggerEvent(
      'session_updated',
      { agent_session_id: 'sess-1', folderId: null },
      '79',
    );

    expect(mockSessionStoreActions.updateSession).toHaveBeenCalledWith('sess-1', {
      folderId: null,
    });
  });

  test('기존 entry 없는 session_updated는 updatedAt이 있으면 최소 세션으로 upsert한다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: {},
      sessionList: [],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    const first = globalThis.__lastSSEInstance;
    first.triggerEvent(
      'session_updated',
      {
        agent_session_id: 'sess-new',
        status: 'completed',
        updated_at: '2026-05-16T04:00:00Z',
        session_type: 'claude',
        userName: '서소영',
      },
      '81',
    );

    expect(mockSessionStoreActions.updateSession).not.toHaveBeenCalled();
    expect(mockSessionStoreActions.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: 'sess-new',
        displayName: null,
        status: 'completed',
        createdAt: '2026-05-16T04:00:00Z',
        updatedAt: '2026-05-16T04:00:00Z',
        sessionType: 'claude',
        userName: '서소영',
      }),
    );
  });

  test('기존 entry 없는 text_delta session_updated는 새 세션을 만들지 않는다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: {},
      sessionList: [],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    const first = globalThis.__lastSSEInstance;
    first.triggerEvent(
      'session_updated',
      {
        agent_session_id: 'sess-delta-only',
        status: 'running',
        updated_at: '2026-05-16T04:00:00Z',
        last_message: {
          type: 'text_delta',
          preview: '스트리밍 중',
          timestamp: '2026-05-16T04:00:00Z',
        },
      },
      '82',
    );

    expect(mockSessionStoreActions.updateSession).not.toHaveBeenCalled();
    expect(mockSessionStoreActions.upsertSession).not.toHaveBeenCalled();
  });

  test('첫 connect는 feed scope를 지정하고 lastEventId·instanceId는 생략한다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: {},
      sessionList: [],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    const sse = globalThis.__lastSSEInstance;
    expect(sse.url).toBe(`${mockServerUrl}/api/sessions/stream?feed_only=true`);
  });
});

describe('useSessionsStream — scoped gap snapshot은 피드 membership만 reconcile', () => {
  test('마운트 직후 초기 fetch는 mergeSessions와 scoped membership reconcile을 호출한다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: { 'sess-a': { folderId: null, displayName: 'A' } },
      sessionList: [
        {
          agentSessionId: 'sess-a',
          displayName: 'A',
          status: 'idle',
          createdAt: '2026-05-05T00:00:00Z',
          updatedAt: '2026-05-05T00:00:00Z',
        },
      ],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockSessionStoreActions.setSessions).not.toHaveBeenCalled();
    expect(mockSessionStoreActions.mergeSessions).toHaveBeenCalledTimes(1);
    expect(mockSessionStoreActions.reconcileSessions).not.toHaveBeenCalled();
    expect(mockSessionStoreActions.setFeedCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessions: { 'sess-a': expect.anything() } }),
    );
  });

  test('replay_gap 뒤 exclude delta가 내린 열린 상세 cache를 보존한다', async () => {
    mockGetCatalog.mockResolvedValue(feedOnlyCatalogWire);

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });
    // 마운트 fetch 후 상세에서 열어 둔 session은 feed_only snapshot에 없다.
    expect(mockSessionStoreActions.setSessions).not.toHaveBeenCalled();
    mockSessionStoreActions.mergeSessions.mockClear();
    mockSessionStoreActions.setFeedCatalogSnapshot.mockClear();
    mockSessionStoreActions.upsertSession({
      agentSessionId: 'open-detail',
      displayName: 'Open detail',
      status: 'running',
      createdAt: '2026-09-22T00:00:00Z',
      updatedAt: '2026-09-22T00:00:00Z',
      folderId: 'visible',
    });

    const sse = globalThis.__lastSSEInstance;
    // server session_stream_event_filter는 visible → excluded 전환을 assignment null로 보낸다.
    sse.triggerEvent('catalog_updated', excludedCatalogDeltaWire, '101');
    expect(mockSessionStoreActions.catalog.sessions['open-detail']).toBeUndefined();
    expect(mockSessionStoreActions.sessions['open-detail']).toEqual(
      expect.objectContaining({ displayName: 'Open detail' }),
    );

    sse.triggerEvent('stream_meta', { instance_id: 'inst-A', latest_id: 100 });
    sse.triggerEvent('replay_gap', { latest_id: 500, instance_id: 'inst-A' });
    await act(async () => {
      await Promise.resolve();
    });

    // gap refetch는 feed snapshot만 merge한다. scoped assignment keys로 global cache를 지우면 안 된다.
    // mapper(toSession)가 정규화 후 camelCase Session으로 store에 전달한다.
    expect(mockSessionStoreActions.mergeSessions).toHaveBeenCalledTimes(1);
    expect(mockSessionStoreActions.mergeSessions.mock.calls[0][0]).toEqual([
      expect.objectContaining({ agentSessionId: 'visible' }),
    ]);
    expect(mockSessionStoreActions.reconcileSessions).not.toHaveBeenCalled();
    expect(mockSessionStoreActions.setFeedCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessions: { visible: expect.anything() } }),
    );
    expect(mockSessionStoreActions.sessions['open-detail']).toEqual(
      expect.objectContaining({ displayName: 'Open detail' }),
    );

    expect(mockSessionStoreActions.setSessions).not.toHaveBeenCalled();
  });

  test('stream_meta instance 교체도 scoped snapshot으로 열린 상세 cache를 삭제하지 않는다', async () => {
    mockGetCatalog.mockResolvedValue(feedOnlyCatalogWire);

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    const sse = globalThis.__lastSSEInstance;
    mockSessionStoreActions.mergeSessions.mockClear();
    mockSessionStoreActions.setFeedCatalogSnapshot.mockClear();
    mockSessionStoreActions.upsertSession({
      agentSessionId: 'open-detail',
      displayName: 'Open detail',
      status: 'running',
      createdAt: '2026-09-22T00:00:00Z',
      updatedAt: '2026-09-22T00:00:00Z',
      folderId: 'excluded',
    });
    sse.triggerEvent('catalog_updated', excludedCatalogDeltaWire, '101');
    // 첫 stream_meta — ref만 채움 (refetch 없음).
    sse.triggerEvent('stream_meta', { instance_id: 'inst-A', latest_id: 100 });
    // 두 번째 stream_meta — instance 교체 → refetch.
    sse.triggerEvent('stream_meta', { instance_id: 'inst-B', latest_id: 250 });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockSessionStoreActions.mergeSessions).toHaveBeenCalledTimes(1);
    expect(mockSessionStoreActions.reconcileSessions).not.toHaveBeenCalled();
    expect(mockSessionStoreActions.setFeedCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ sessions: { visible: expect.anything() } }),
    );
    expect(mockSessionStoreActions.sessions['open-detail']).toEqual(
      expect.objectContaining({ displayName: 'Open detail' }),
    );
    expect(mockSessionStoreActions.setSessions).not.toHaveBeenCalled();
  });
});

describe('useSessionsStream — initial catalog REST와 SSE delta race', () => {
  test('folder_updated는 다른 기기의 폴더 변경을 카탈로그에 반영한다', async () => {
    mockGetCatalog
      .mockResolvedValueOnce({ folders: [{ id: 'folder-1', name: '이전', sortOrder: 0 }], sessions: {}, sessionList: [] })
      .mockResolvedValueOnce({ folders: [{ id: 'folder-1', name: '변경 후', sortOrder: 0 }], sessions: {}, sessionList: [] });

    renderHook(() => useSessionsStream());
    await waitFor(() => expect(mockGetCatalog).toHaveBeenCalledTimes(1));
    globalThis.__lastSSEInstance.triggerEvent('folder_updated', { folderId: 'folder-1' });

    await waitFor(() => expect(mockSessionStoreActions.setFeedCatalogSnapshot)
      .toHaveBeenLastCalledWith(expect.objectContaining({
        folders: [expect.objectContaining({ id: 'folder-1', name: '변경 후' })],
      })));
  });

  test('catalog_updated nested folder payload는 parentFolderId를 보존한다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: {},
      sessionList: [],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    const sse = globalThis.__lastSSEInstance;
    sse.triggerEvent('catalog_updated', {
      catalog: {
        folders: [
          { id: 'root', name: 'Root', sortOrder: 0, parentFolderId: null },
          { id: 'child', name: 'Child', sortOrder: 0, parentFolderId: 'root' },
        ],
        sessions: { 'sess-1': { folderId: 'child', displayName: 'Nested' } },
      },
    });

    expect(mockSessionStoreActions.setFeedCatalogSnapshot).toHaveBeenLastCalledWith({
      folders: [
        { id: 'root', name: 'Root', sortOrder: 0, parentFolderId: null },
        { id: 'child', name: 'Child', sortOrder: 0, parentFolderId: 'root' },
      ],
      sessions: { 'sess-1': { folderId: 'child', displayName: 'Nested' } },
    });
  });

  test('신형 catalog_updated는 추가·수정·삭제 델타를 병합하고 전체 catalog를 교체하지 않는다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [{ id: 'old', name: 'Old', sortOrder: 0 }],
      sessions: {
        unchanged: { folderId: 'old', displayName: 'Unchanged' },
        updated: { folderId: 'old', displayName: 'Before' },
        removed: { folderId: 'old', displayName: 'Remove me' },
      },
      sessionList: [],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    mockSessionStoreActions.setFeedCatalogSnapshot.mockClear();
    mockSessionStoreActions.applyCatalogDelta.mockClear();
    const sse = globalThis.__lastSSEInstance;
    sse.triggerEvent('catalog_updated', {
      folders: [{ id: 'new', name: 'New', sortOrder: 0 }],
      sessions_delta: {
        added: { folderId: 'new', displayName: 'Added' },
        updated: { folderId: 'new', displayName: 'After' },
        removed: null,
      },
    });

    expect(mockSessionStoreActions.setFeedCatalogSnapshot).not.toHaveBeenCalled();
    expect(mockSessionStoreActions.applyCatalogDelta).toHaveBeenCalledWith(
      [{ id: 'new', name: 'New', sortOrder: 0 }],
      {
        added: { folderId: 'new', displayName: 'Added' },
        updated: { folderId: 'new', displayName: 'After' },
        removed: null,
      },
    );
    expect(mockSessionStoreActions.catalog).toEqual({
      folders: [{ id: 'new', name: 'New', sortOrder: 0 }],
      sessions: {
        unchanged: { folderId: 'old', displayName: 'Unchanged' },
        updated: { folderId: 'new', displayName: 'After' },
        added: { folderId: 'new', displayName: 'Added' },
      },
    });
  });

  test('신형 catalog_updated의 빈 sessions_delta는 폴더만 갱신한다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [{ id: 'old', name: 'Old', sortOrder: 0 }],
      sessions: {
        unchanged: { folderId: 'old', displayName: 'Unchanged' },
      },
      sessionList: [],
    });

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    const previousSessions = mockSessionStoreActions.catalog.sessions;
    mockSessionStoreActions.setFeedCatalogSnapshot.mockClear();
    const sse = globalThis.__lastSSEInstance;
    sse.triggerEvent('catalog_updated', {
      folders: [{ id: 'renamed', name: 'Renamed', sortOrder: 0 }],
      sessions_delta: {},
    });

    expect(mockSessionStoreActions.setFeedCatalogSnapshot).not.toHaveBeenCalled();
    expect(mockSessionStoreActions.catalog.folders).toEqual([
      { id: 'renamed', name: 'Renamed', sortOrder: 0 },
    ]);
    expect(mockSessionStoreActions.catalog.sessions).toBe(previousSessions);
  });

  test('initial catalog pending 중 받은 신형 델타는 stale snapshot 뒤 다시 적용된다', async () => {
    let resolveCatalog: ((value: unknown) => void) | null = null;
    mockGetCatalog.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCatalog = resolve;
        }),
    );

    renderHook(() => useSessionsStream());
    const sse = globalThis.__lastSSEInstance;
    sse.triggerEvent('catalog_updated', {
      folders: [{ id: 'fresh', name: 'Fresh', sortOrder: 0 }],
      sessions_delta: {
        'sess-race': { folderId: 'fresh', displayName: 'Fresh' },
      },
    });

    expect(mockSessionStoreActions.applyCatalogDelta).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCatalog?.({
        folders: [{ id: 'stale', name: 'Stale', sortOrder: 0 }],
        sessions: {
          'sess-race': { folderId: 'stale', displayName: 'Stale' },
        },
        sessionList: [],
      });
      await Promise.resolve();
    });

    expect(mockSessionStoreActions.applyCatalogDelta).toHaveBeenCalledTimes(2);
    expect(mockSessionStoreActions.catalog).toEqual({
      folders: [{ id: 'fresh', name: 'Fresh', sortOrder: 0 }],
      sessions: {
        'sess-race': { folderId: 'fresh', displayName: 'Fresh' },
      },
    });
  });

  test('initial catalog pending 중 도착한 session_updated와 catalog_updated는 snapshot 적용 후 재적용된다', async () => {
    let resolveCatalog: ((v: unknown) => void) | null = null;
    mockGetCatalog.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCatalog = resolve;
        }),
    );

    renderHook(() => useSessionsStream());
    const sse = globalThis.__lastSSEInstance;

    sse.triggerEvent(
      'session_updated',
      {
        agent_session_id: 'sess-race',
        status: 'running',
        updated_at: '2026-05-16T03:00:01Z',
        last_message: {
          type: 'assistant_message',
          preview: '최신 응답',
          timestamp: '2026-05-16T03:00:01Z',
        },
      },
      '80',
    );
    sse.triggerEvent('catalog_updated', {
      catalog: {
        folders: [{ id: 'fresh', name: 'Fresh', sortOrder: 0 }],
        sessions: { 'sess-race': { folderId: 'fresh', displayName: 'Fresh' } },
      },
    });

    expect(mockSessionStoreActions.upsertSession).toHaveBeenCalledTimes(1);
    expect(mockSessionStoreActions.updateSession).not.toHaveBeenCalled();
    expect(mockSessionStoreActions.setFeedCatalogSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCatalog?.({
        folders: [{ id: 'stale', name: 'Stale', sortOrder: 0 }],
        sessions: { 'sess-race': { folderId: 'stale', displayName: 'Stale' } },
        sessionList: [
          {
            agentSessionId: 'sess-race',
            displayName: 'Stale',
            status: 'idle',
            createdAt: '2026-05-16T03:00:00Z',
            updatedAt: '2026-05-16T03:00:00Z',
          },
        ],
      });
      await Promise.resolve();
    });

    expect(mockSessionStoreActions.mergeSessions).toHaveBeenCalledWith([
      expect.objectContaining({
        agentSessionId: 'sess-race',
        status: 'idle',
      }),
    ]);
    expect(mockSessionStoreActions.updateSession).toHaveBeenCalledTimes(1);
    expect(mockSessionStoreActions.updateSession).toHaveBeenLastCalledWith(
      'sess-race',
      expect.objectContaining({
        status: 'running',
        lastMessage: {
          type: 'assistant_message',
          preview: '최신 응답',
          timestamp: '2026-05-16T03:00:01Z',
        },
        updatedAt: '2026-05-16T03:00:01Z',
      }),
    );
    expect(mockSessionStoreActions.setFeedCatalogSnapshot).toHaveBeenLastCalledWith({
      folders: [{ id: 'fresh', name: 'Fresh', sortOrder: 0 }],
      sessions: { 'sess-race': { folderId: 'fresh', displayName: 'Fresh' } },
    });
  });

  test('초기 REST catalog 실패 후 SSE session_list를 fallback snapshot으로 적용한다', async () => {
    mockGetCatalog.mockRejectedValueOnce(new Error('offline'));

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    const sse = globalThis.__lastSSEInstance;
    sse.triggerEvent('session_list', {
      sessions: [
        {
          agentSessionId: 'sess-list',
          displayName: 'Fallback',
          status: 'idle',
          createdAt: '2026-05-16T05:00:00Z',
          updatedAt: '2026-05-16T05:00:00Z',
          folderId: 'folder-a',
        },
      ],
      total: 1,
    });

    expect(mockSessionStoreActions.setFeedCatalogSnapshot).toHaveBeenCalledWith({
      folders: [],
      sessions: {
        'sess-list': { folderId: 'folder-a', displayName: 'Fallback' },
      },
    });
    expect(mockSessionStoreActions.mergeSessions).toHaveBeenCalledWith([
      expect.objectContaining({
        agentSessionId: 'sess-list',
        displayName: 'Fallback',
        folderId: 'folder-a',
      }),
    ]);
  });

  test('초기 REST와 SSE fallback 모두 없으면 empty 대신 catalog 오류 상태를 기록한다', async () => {
    mockGetCatalog.mockRejectedValueOnce(new Error('offline'));

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockSessionStoreActions.markCatalogLoadFailed).toHaveBeenCalledTimes(1);
  });

  test('initial REST pending 중 받은 catalog delta가 있으면 REST 실패가 오류 상태를 덮지 않는다', async () => {
    let rejectCatalog!: (error: Error) => void;
    mockGetCatalog.mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        rejectCatalog = reject;
      }),
    );

    renderHook(() => useSessionsStream());
    const sse = globalThis.__lastSSEInstance;
    sse.triggerEvent('catalog_updated', {
      catalog: {
        folders: [{ id: 'fallback', name: 'SSE fallback', sortOrder: 0 }],
        sessions: {},
      },
    });

    await act(async () => {
      rejectCatalog(new Error('offline'));
      await Promise.resolve();
    });

    expect(mockSessionStoreActions.catalogLoadState).toBe('ready');
    expect(mockSessionStoreActions.markCatalogLoadFailed).not.toHaveBeenCalled();
  });

  test('초기 REST pending 중 받은 session_list는 REST reject 후 fallback snapshot으로 적용한다', async () => {
    let rejectCatalog!: (err: Error) => void;
    mockGetCatalog.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectCatalog = reject;
        }),
    );

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });

    const sse = globalThis.__lastSSEInstance;
    sse.triggerEvent('session_list', {
      sessions: [
        {
          agentSessionId: 'sess-buffered',
          displayName: 'Buffered',
          status: 'idle',
          createdAt: '2026-05-16T06:00:00Z',
          updatedAt: '2026-05-16T06:00:00Z',
          folderId: null,
        },
      ],
      total: 1,
    });

    expect(mockSessionStoreActions.mergeSessions).not.toHaveBeenCalled();

    await act(async () => {
      rejectCatalog(new Error('offline'));
      await Promise.resolve();
    });

    expect(mockSessionStoreActions.setFeedCatalogSnapshot).toHaveBeenCalledWith({
      folders: [],
      sessions: {
        'sess-buffered': { folderId: null, displayName: 'Buffered' },
      },
    });
    expect(mockSessionStoreActions.mergeSessions).toHaveBeenCalledWith([
      expect.objectContaining({
        agentSessionId: 'sess-buffered',
        displayName: 'Buffered',
        folderId: null,
      }),
    ]);
  });
});

describe('useSessionsStream — AppState 게이트로 catalog 능동 refetch', () => {
  function fireAppState(state: 'active' | 'background' | 'inactive') {
    const listeners = (globalThis as any).__appStateListeners ?? [];
    for (const fn of listeners) fn(state);
  }

  beforeEach(() => {
    (globalThis as any).__appStateListeners = [];
    const AppStateMock = require('react-native/Libraries/AppState/AppState').default;
    AppStateMock.currentState = 'active';
  });

  test('background → inactive → active 전이 시 getCatalog가 추가 호출된다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: {},
      sessionList: [],
    });

    renderHook(() => useSessionsStream());

    // 마운트 시 초기 catalog 페치 1회.
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);

    // background → inactive → active 전이 → refetchCatalogOnGap 호출 → getCatalog 추가 호출
    await act(async () => {
      fireAppState('background');
      fireAppState('inactive');
      fireAppState('active');
      await Promise.resolve();
    });

    expect(mockGetCatalog).toHaveBeenCalledTimes(2);
  });

  test('background 복귀의 scoped snapshot도 exclude된 열린 상세 cache를 지우지 않는다', async () => {
    mockGetCatalog.mockResolvedValue(feedOnlyCatalogWire);

    renderHook(() => useSessionsStream());
    await act(async () => {
      await Promise.resolve();
    });
    const sse = globalThis.__lastSSEInstance;
    mockSessionStoreActions.upsertSession({
      agentSessionId: 'open-detail',
      displayName: 'Open detail',
      status: 'running',
      createdAt: '2026-09-22T00:00:00Z',
      updatedAt: '2026-09-22T00:00:00Z',
      folderId: 'visible',
    });
    sse.triggerEvent('catalog_updated', excludedCatalogDeltaWire, '101');
    expect(mockSessionStoreActions.catalog.sessions['open-detail']).toBeUndefined();

    await act(async () => {
      fireAppState('background');
      fireAppState('active');
      await Promise.resolve();
    });

    expect(mockSessionStoreActions.reconcileSessions).not.toHaveBeenCalled();
    expect(mockSessionStoreActions.sessions['open-detail']).toEqual(
      expect.objectContaining({ displayName: 'Open detail' }),
    );
  });

  test('active → inactive → active 전이는 catalog refetch를 트리거하지 않는다', async () => {
    mockGetCatalog.mockResolvedValue({
      folders: [],
      sessions: {},
      sessionList: [],
    });

    renderHook(() => useSessionsStream());

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireAppState('inactive');
      fireAppState('active');
      await Promise.resolve();
    });

    // 초기 마운트 1회 외 추가 호출 없음
    expect(mockGetCatalog).toHaveBeenCalledTimes(1);
  });
});
