import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PersistentReportEntry, Session } from '../../api/types';
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

function reportEntry(key: string): PersistentReportEntry {
  return {
    key,
    kind: 'ask',
    title: key,
    card_numbers: [],
    context: '',
    action: '',
    options: [],
    state: 'open',
    answer: '',
    updated_at: '2026-10-02T00:00:00Z',
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as Response;
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
    persistentReportsBySession: {},
    feedMembership: {},
    feedSessionIds: [],
    feedPage: { hasMore: false, nextCursor: null, status: 'idle' },
    catalogReady: false,
    catalogLoadState: 'loading',
    catalogRetryRequest: 0,
    pendingAttentionVersionsBySession: {},
  });
});

test('보고 store에만 있는 PAS는 session_list 누락 뒤 빈 보고를 REST에서 반영한다', async () => {
  const sessionId = 'report-only';
  useSessionStore.getState().applyPersistentReport(sessionId, [reportEntry('old')]);
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockResolvedValue(jsonResponse({
    sessions: [{ ...session(sessionId, 7), persistentReport: [] }],
  }));
  const hook = renderHook(() => useSessionsStream());

  emit('stream_meta', { instance_id: 'node-a', latest_id: 100 });
  emit('session_list', snapshotPayload([]));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(new URL(fetchMock.mock.calls[0][0]).searchParams.getAll('session_id')).toEqual([sessionId]);
  await waitFor(() => expect(useSessionStore.getState().persistentReportsBySession[sessionId]?.entries).toEqual([]));
  expect(useSessionStore.getState().feedMembership[sessionId]).toBeUndefined();
  expect(useSessionStore.getState().feedSessionIds).not.toContain(sessionId);
  hook.unmount();
});

test('보고 보충 조회는 완료 PAS의 서버 최신 장만 남긴다', async () => {
  const sessionId = 'completed-pas';
  const remaining = reportEntry('remaining');
  useSessionStore.getState().applyPersistentReport(sessionId, [reportEntry('removed'), remaining]);
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockResolvedValue(jsonResponse({
    sessions: [{ ...session(sessionId, 7), persistentReport: [remaining] }],
  }));
  const hook = renderHook(() => useSessionsStream());

  emit('stream_meta', { instance_id: 'node-a', latest_id: 100 });
  emit('session_list', snapshotPayload([]));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(useSessionStore.getState().persistentReportsBySession[sessionId]?.entries).toEqual([remaining]));
  expect(useSessionStore.getState().feedMembership[sessionId]).toBeUndefined();
  expect(useSessionStore.getState().feedSessionIds).not.toContain(sessionId);
  hook.unmount();
});

test('보충 조회 중 도착한 보고 SSE는 이전 REST 응답보다 우선한다', async () => {
  const sessionId = 'report-race';
  const initial = reportEntry('initial');
  const latest = reportEntry('latest');
  useSessionStore.getState().applyPersistentReport(sessionId, [initial]);
  let resolveResponse!: (response: Response) => void;
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
  const hook = renderHook(() => useSessionsStream());

  emit('stream_meta', { instance_id: 'node-a', latest_id: 100 });
  emit('session_list', snapshotPayload([]));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  emit('session_updated', { agent_session_id: sessionId, persistent_report: [latest] }, '101');

  await act(async () => {
    resolveResponse(jsonResponse({
      sessions: [{ ...session(sessionId, 7), persistentReport: [initial] }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(useSessionStore.getState().persistentReportsBySession[sessionId]?.entries).toEqual([latest]);
  expect(useSessionStore.getState().feedMembership[sessionId]).toBeUndefined();
  hook.unmount();
});

test('실행 중 목록과 보고 store에 모두 있는 PAS는 한 번만 보충 조회한다', async () => {
  const sessionId = 'running-and-reported';
  useSessionStore.setState({ sessions: { [sessionId]: session(sessionId, 0) } });
  useSessionStore.getState().applyPersistentReport(sessionId, []);
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockResolvedValue(jsonResponse({
    sessions: [{ ...session(sessionId, 0), persistentReport: [] }],
  }));
  const hook = renderHook(() => useSessionsStream());

  emit('stream_meta', { instance_id: 'node-a', latest_id: 100 });
  emit('session_list', snapshotPayload([]));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(new URL(fetchMock.mock.calls[0][0]).searchParams.getAll('session_id')).toEqual([sessionId]);
  const feedIds = useSessionStore.getState().feedSessionIds;
  expect(new Set(feedIds).size).toBe(feedIds.length);
  hook.unmount();
});

test('보충 조회 실패는 기존 보고를 유지한다', async () => {
  const sessionId = 'failed-report-catchup';
  const existing = reportEntry('keep');
  useSessionStore.getState().applyPersistentReport(sessionId, [existing]);
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockRejectedValue(new Error('offline'));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const hook = renderHook(() => useSessionsStream());

  emit('stream_meta', { instance_id: 'node-a', latest_id: 100 });
  emit('session_list', snapshotPayload([]));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await act(async () => { await Promise.resolve(); });
  expect(useSessionStore.getState().persistentReportsBySession[sessionId]?.entries).toEqual([existing]);
  hook.unmount();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test('복귀 session_list는 60행 후보를 첫 30행으로 바꾸고 상세 cache를 보존한다', async () => {
  const hook = renderHook(() => useSessionsStream());
  emit('stream_meta', { instance_id: 'node-a', latest_id: 100 });
  const firstPage = pageRows(0);
  const secondPage = pageRows(30);
  emit('session_list', snapshotPayload(firstPage));
  addSecondPage(secondPage);
  expect(useSessionStore.getState().feedSessionIds).toHaveLength(60);
  const detail = {
    agentSessionId: 'detail-only',
    displayName: '열린 상세',
    status: 'completed',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
  } as Session;
  useSessionStore.getState().mergeSessions([detail]);
  expect(useSessionStore.getState().feedMembership).toHaveProperty('page-59');

  const cachedRows = [...firstPage, ...secondPage];
  const fetchMock = global.fetch as jest.Mock;
  const responsePromises: Promise<Response>[] = [];
  fetchMock.mockImplementation((input) => {
    const requestedIds = new URL(String(input)).searchParams.getAll('session_id');
    const rows = requestedIds.flatMap((id) => {
      const row = cachedRows.find((candidate) => candidate.agentSessionId === id);
      return row ? [row] : [];
    });
    const response = Promise.resolve(jsonResponse({ sessions: rows }));
    responsePromises.push(response);
    return response;
  });

  const refreshedRows = pageRows(100);
  const snapshotIds = new Set(refreshedRows.map((row) => row.agentSessionId));
  emit('stream_meta', { instance_id: 'node-b', latest_id: 700 });
  emit('session_list', snapshotPayload(refreshedRows));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
  await act(async () => {
    await Promise.all(responsePromises);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const requestedIds = fetchMock.mock.calls.flatMap(([input]) => (
    new URL(String(input)).searchParams.getAll('session_id')
  ));
  const expectedOmittedRunningIds = cachedRows
    .filter((row) => row.status === 'running' && !snapshotIds.has(row.agentSessionId))
    .map((row) => row.agentSessionId);
  const completedCachedIds = new Set([
    ...cachedRows.filter((row) => row.status === 'completed').map((row) => row.agentSessionId),
    detail.agentSessionId,
  ]);
  expect(expectedOmittedRunningIds).toEqual([
    'page-0', 'page-1', 'page-2', 'page-3', 'page-4', 'page-5', 'page-6',
  ]);
  expect(requestedIds).toEqual(expectedOmittedRunningIds);
  expect(requestedIds.some((id) => snapshotIds.has(id))).toBe(false);
  expect(requestedIds.some((id) => completedCachedIds.has(id))).toBe(false);

  const store = useSessionStore.getState();
  expect(store.feedSessionIds).toHaveLength(30);
  expect(store.feedSessionIds).toEqual(
    [...refreshedRows].reverse().map((row) => row.agentSessionId),
  );
  expect(Object.values(store.feedMembership)).toHaveLength(30);
  expect(store.feedMembership['page-59']).toBeUndefined();
  expect(store.feedMembership['page-100']).toBe('candidate');
  expect(store.sessions['page-0'].status).toBe('running');
  expect(store.feedMembership['page-0']).toBeUndefined();
  expect(store.sessions['page-59']).toMatchObject({
    displayName: 'Session page-59',
    status: 'completed',
  });
  expect(store.sessions['detail-only']).toBe(detail);
  expect(store.feedPage).toMatchObject({ hasMore: true, nextCursor: '30', status: 'idle' });
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
