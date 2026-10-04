import { act, renderHook } from '@testing-library/react-native';
import { useSessionStore } from '../../store/sessionStore';
import { usePlannerStore } from '../../store/plannerStore';
import { useSessionsStream } from '../useSessionsStream';

jest.mock('../../store/settingsStore', () => ({
  useSettingsStore: Object.assign((selector: any) => selector({ serverUrl: 'https://server.test' }), {
    getState: () => ({ serverUrl: 'https://server.test' }), subscribe: () => () => {},
  }),
}));
jest.mock('../../store/authStore', () => ({
  useAuthStore: Object.assign(jest.fn(), {
    getState: () => ({ jwt: null }), subscribe: () => () => {},
  }),
}));
const mockGetCatalog = jest.fn();
jest.mock('../../api/client', () => ({
  createApiClient: () => ({
    ...require('../../api/streamEndpoints').createStreamEndpoints({ base: 'https://server.test' }),
    getCatalog: mockGetCatalog,
  }),
}));

const timestamp = '2026-10-04T12:00:00Z';
function snapshot(eventId = 1002) {
  return {
    folders: [], sessions: { s: { folderId: null, displayName: 'Session' } },
    sessionList: [{
      agentSessionId: 's', displayName: 'Session', status: 'running',
      createdAt: timestamp, updatedAt: timestamp,
      lastMessage: { type: 'assistant_message', preview: `preview-${eventId}`, timestamp, eventId },
    }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const cleanups: Array<() => void> = [];
const source = () => (globalThis as any).__lastSSEInstance;
function emit(type: string, data: any, id = '') {
  act(() => source().triggerEvent(type, data, id));
}
function lifecycle() {
  act(() => {
    for (const state of ['background', 'inactive', 'active']) {
      [...(globalThis as any).__appStateListeners].forEach((fn: any) => fn(state));
    }
  });
}
async function mount() {
  mockGetCatalog.mockResolvedValueOnce(snapshot(1000));
  const hook = renderHook(() => useSessionsStream());
  await act(async () => {});
  emit('stream_meta', { instance_id: 'old', latest_id: 100 });
  emit('session_updated', { agent_session_id: 's', status: 'running' }, '100');
  return hook;
}
beforeEach(() => {
  mockGetCatalog.mockReset();
  mockGetCatalog.mockResolvedValue(snapshot());
  jest.clearAllMocks();
  useSessionStore.setState({ sessions: {}, catalog: { folders: [], sessions: {} }, catalogReady: false, catalogRetryRequest: 0, feedSessionIds: [], feedScopeTombstoneIds: {}, pendingAttentionVersionsBySession: {} });
  usePlannerStore.getState().resetForTest();
});
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); jest.restoreAllMocks(); jest.useRealTimers(); });

test('foreground small replay uses one reconnect, no extra REST', async () => {
  const hook = await mount();
  const old = source();
  lifecycle();
  expect(old.closed).toBe(true);
  expect(source()).not.toBe(old);
  expect(source().url).toContain('lastEventId=100');
  expect(source().url).toContain('snapshotCatchup=1');
  emit('session_updated', { agent_session_id: 's', status: 'idle' }, '101');
  expect(mockGetCatalog).toHaveBeenCalledTimes(1);
  expect(useSessionStore.getState().sessions.s.status).toBe('idle');
  hook.unmount();
});

test('gap buffers live store/planner work, then keeps snapshot preview and applies status/review in order', async () => {
  const hook = await mount();
  const rest = deferred<ReturnType<typeof snapshot>>();
  mockGetCatalog.mockReturnValueOnce(rest.promise);
  const commits: string[] = [];
  let sorts = 0;
  const stop = useSessionStore.subscribe((state, prev) => {
    if (state.sessions !== prev.sessions) commits.push(state.sessions.s?.lastMessage?.preview ?? 'empty');
    if (state.feedSessionIds !== prev.feedSessionIds) sorts++;
  });
  cleanups.push(stop);
  const invalidate = jest.spyOn(usePlannerStore.getState(), 'invalidate');
  emit('replay_gap', { instance_id: 'old', latest_id: 300, reason: 'catchup_overflow' });
  emit('session_updated', {
    agent_session_id: 's', status: 'idle', review_state: 'acknowledged',
    last_message: snapshot(1001).sessionList[0].lastMessage,
  }, '301');
  emit('session_updated', { agent_session_id: 's', review_required: true }, '302');
  expect(commits).toEqual([]);
  expect(invalidate).not.toHaveBeenCalled();
  expect(useSessionStore.getState().sessions.s.status).toBe('running');
  await act(async () => rest.resolve(snapshot()));
  expect(useSessionStore.getState().sessions.s).toMatchObject({
    status: 'idle', reviewState: 'acknowledged', reviewRequired: true,
    lastMessage: { preview: 'preview-1002' },
  });
  expect(commits).toEqual(['preview-1002', 'preview-1002', 'preview-1002']);
  expect(invalidate).toHaveBeenCalledTimes(3); // two live deltas + successful recovery
  console.info('catchup metrics', { sessionCommits: commits.length, feedSorts: sorts, plannerInvalidations: invalidate.mock.calls.length, pendingCommits: 0 });
  lifecycle();
  expect(source().url).toContain('lastEventId=302');
  stop(); invalidate.mockRestore(); hook.unmount();
});

test('instance mismatch metadata + gap trigger one REST and commit only after recovery', async () => {
  const hook = await mount();
  const rest = deferred<ReturnType<typeof snapshot>>();
  mockGetCatalog.mockReturnValueOnce(rest.promise);
  emit('stream_meta', { instance_id: 'new', latest_id: 5 });
  emit('replay_gap', { instance_id: 'new', latest_id: 5, reason: 'instance_mismatch' });
  expect(mockGetCatalog).toHaveBeenCalledTimes(2);
  await act(async () => rest.resolve(snapshot()));
  lifecycle();
  expect(source().url).toContain('instanceId=new');
  expect(source().url).toContain('lastEventId=5');
  hook.unmount();
});

test('failed snapshot leaves committed cursor/cache and uses existing transport retry', async () => {
  const hook = await mount();
  jest.useFakeTimers();
  const rest = deferred<ReturnType<typeof snapshot>>();
  mockGetCatalog.mockReturnValueOnce(rest.promise);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const old = source();
  emit('stream_meta', { instance_id: 'new', latest_id: 5 });
  emit('replay_gap', { instance_id: 'new', latest_id: 5 });
  emit('session_updated', { agent_session_id: 's', status: 'idle' }, '6');
  await act(async () => rest.reject(new Error('offline')));
  expect(useSessionStore.getState().sessions.s.status).toBe('running');
  expect(old.closed).toBe(true);
  act(() => jest.advanceTimersByTime(30_000));
  expect(source()).not.toBe(old);
  expect(source().url).toContain('lastEventId=100');
  expect(source().url).toContain('instanceId=old');
  mockGetCatalog.mockResolvedValueOnce(snapshot());
  emit('stream_meta', { instance_id: 'new', latest_id: 6 });
  await act(async () => source().triggerEvent('replay_gap', { instance_id: 'new', latest_id: 6 }));
  expect(mockGetCatalog).toHaveBeenCalledTimes(3);
  warn.mockRestore(); hook.unmount();
});

test.each(['mergeSessions', 'upsertSession', 'updateSession'] as const)(
  '%s preserves newer preview while applying other fields', (method) => {
    const store = useSessionStore.getState();
    store.upsertSession(snapshot().sessionList[0]);
    const older = { ...snapshot(1001).sessionList[0], status: 'idle', reviewState: 'acknowledged' as const };
    if (method === 'mergeSessions') store.mergeSessions([older]);
    else if (method === 'upsertSession') store.upsertSession(older);
    else store.updateSession('s', older);
    expect(useSessionStore.getState().sessions.s).toMatchObject({
      status: 'idle', reviewState: 'acknowledged', lastMessage: { preview: 'preview-1002' },
    });
  },
);

test('gap supersedes initial hydration; folder refresh keeps the same buffered tail and only latest response commits', async () => {
  const initial = deferred<ReturnType<typeof snapshot>>();
  const gap = deferred<ReturnType<typeof snapshot>>();
  const folder = deferred<ReturnType<typeof snapshot>>();
  mockGetCatalog.mockReset();
  mockGetCatalog.mockReturnValueOnce(initial.promise).mockReturnValueOnce(gap.promise).mockReturnValueOnce(folder.promise);
  const hook = renderHook(() => useSessionsStream());
  emit('stream_meta', { instance_id: 'old', latest_id: 300 });
  emit('replay_gap', { instance_id: 'old', latest_id: 300 });
  emit('session_updated', { agent_session_id: 's', status: 'idle', last_message: snapshot(1001).sessionList[0].lastMessage }, '301');
  emit('folder_updated', {}, '302');
  const latest = snapshot(1002);
  latest.sessionList[0].displayName = 'latest';
  await act(async () => folder.resolve(latest));
  expect(useSessionStore.getState().sessions.s).toMatchObject({ status: 'idle', displayName: 'latest', lastMessage: { preview: 'preview-1002' } });
  const stale = snapshot(1000);
  stale.sessionList[0].displayName = 'stale';
  await act(async () => { gap.resolve(stale); initial.resolve(stale); });
  expect(useSessionStore.getState().sessions.s.displayName).toBe('latest');
  lifecycle();
  expect(source().url).toContain('lastEventId=302');
  hook.unmount();
});

test('background cancels pending recovery without committing its cursor or late snapshot', async () => {
  const hook = await mount();
  const rest = deferred<ReturnType<typeof snapshot>>();
  mockGetCatalog.mockReturnValueOnce(rest.promise);
  emit('replay_gap', { instance_id: 'old', latest_id: 300 });
  lifecycle();
  await act(async () => rest.resolve(snapshot(1002)));
  expect(source().url).toContain('lastEventId=100');
  expect(useSessionStore.getState().sessions.s.lastMessage?.preview).toBe('preview-1000');
  hook.unmount();
});
