import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import {
  AGENT_PORTRAIT_FOREGROUND_REFRESH_MS,
  AGENT_PORTRAIT_STORAGE_KEY,
  agentPortraitScope,
  useAgentPortraitStore,
  useAgentPortraitSync,
} from '../agentPortraitStore';
import { createAgentPortraitResolver } from '../../lib/agent-portrait-resolver';
import { useAuthStore } from '../authStore';
import { useSettingsStore } from '../settingsStore';

const SERVER = 'https://soul.test';
// 이메일만 읽으므로 서명은 필요 없다.
const jwtFor = (email: string) =>
  `h.${Buffer.from(JSON.stringify({ email, sub: email, name: 'n', picture: 'p', exp: 9999999999 })).toString('base64url')}.s`;
const JWT = jwtFor('director@test');

const item = (id: string, sha: string) => ({
  agent_id: id, sha256: sha, mime: 'image/png', byte_size: 1, updated_at: 't',
  url: `/api/agent-portraits/${id}?v=${sha}`,
});
const jsonResponse = (portraits: unknown[], etag = '"e1"') => ({
  ok: true, status: 200, headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
  json: async () => ({ portraits }),
});
const fetchMock = jest.fn();

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(1_000_000);
  fetchMock.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  await AsyncStorage.clear();
  useAgentPortraitStore.getState().deactivate();
});
afterEach(() => jest.useRealTimers());

const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

test('200이면 사전을 바꾸고 ETag와 목록을 AsyncStorage에 저장한다', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse([item('seoyoung', 'aaa')]));
  await useAgentPortraitStore.getState().activate(SERVER, JWT);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(`${SERVER}/api/agent-portraits`);
  expect(init.headers).toEqual({ Authorization: `Bearer ${JWT}` });
  const state = useAgentPortraitStore.getState();
  expect(state.ready).toBe(true);
  expect(state.dictionary.get('seoyoung')?.url).toBe('/api/agent-portraits/seoyoung?v=aaa');
  expect(state.etag).toBe('"e1"');
  const stored = JSON.parse((await AsyncStorage.getItem(AGENT_PORTRAIT_STORAGE_KEY))!);
  expect(stored).toEqual({ scope: agentPortraitScope(SERVER, JWT), etag: '"e1"', portraits: [item('seoyoung', 'aaa')] });
});

test('앱 시작 때 저장한 목록을 먼저 읽어 사전을 채우고, 받은 ETag로 If-None-Match를 붙인다', async () => {
  await AsyncStorage.setItem(AGENT_PORTRAIT_STORAGE_KEY, JSON.stringify({
    scope: agentPortraitScope(SERVER, JWT), etag: '"stored"', portraits: [item('seoyoung', 'old')],
  }));
  let release!: (value: unknown) => void;
  fetchMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
  const pending = useAgentPortraitStore.getState().activate(SERVER, JWT);
  await settle();
  // 요청이 끝나기 전에 이미 저장한 목록으로 준비되어 있다.
  expect(useAgentPortraitStore.getState().ready).toBe(true);
  expect(useAgentPortraitStore.getState().dictionary.get('seoyoung')?.url).toContain('v=old');
  expect(fetchMock.mock.calls[0][1].headers['If-None-Match']).toBe('"stored"');
  release({ ok: false, status: 304, headers: { get: () => null }, json: async () => ({}) });
  await pending;
});

test('304면 사전을 그대로 둔다', async () => {
  await AsyncStorage.setItem(AGENT_PORTRAIT_STORAGE_KEY, JSON.stringify({
    scope: agentPortraitScope(SERVER, JWT), etag: '"stored"', portraits: [item('seoyoung', 'old')],
  }));
  fetchMock.mockResolvedValueOnce({ ok: false, status: 304, headers: { get: () => null }, json: async () => ({}) });
  await useAgentPortraitStore.getState().activate(SERVER, JWT);
  const state = useAgentPortraitStore.getState();
  expect(state.dictionary.get('seoyoung')?.url).toContain('v=old');
  expect(state.etag).toBe('"stored"');
  expect(state.ready).toBe(true);
});

test('받기가 실패하면 지금 사전을 지키고, 준비 전이면 준비되지 않은 채 남는다', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await useAgentPortraitStore.getState().activate(SERVER, JWT);
  expect(useAgentPortraitStore.getState().ready).toBe(false);

  fetchMock.mockResolvedValueOnce(jsonResponse([item('seoyoung', 'aaa')]));
  await useAgentPortraitStore.getState().refresh(SERVER, JWT);
  fetchMock.mockResolvedValueOnce({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) });
  await useAgentPortraitStore.getState().refresh(SERVER, JWT);
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await useAgentPortraitStore.getState().refresh(SERVER, JWT);
  const state = useAgentPortraitStore.getState();
  expect(state.ready).toBe(true);
  expect(state.dictionary.get('seoyoung')?.url).toContain('v=aaa');
});

test('foreground 새로 받기는 마지막 시도로부터 60초에 한 번까지다', async () => {
  fetchMock.mockResolvedValue(jsonResponse([item('seoyoung', 'aaa')]));
  await useAgentPortraitStore.getState().activate(SERVER, JWT);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await useAgentPortraitStore.getState().refresh(SERVER, JWT, 'foreground');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  jest.setSystemTime(1_000_000 + AGENT_PORTRAIT_FOREGROUND_REFRESH_MS - 1);
  await useAgentPortraitStore.getState().refresh(SERVER, JWT, 'foreground');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  jest.setSystemTime(1_000_000 + AGENT_PORTRAIT_FOREGROUND_REFRESH_MS);
  await useAgentPortraitStore.getState().refresh(SERVER, JWT, 'foreground');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][1].headers['If-None-Match']).toBe('"e1"');
});

test('서버 주소나 사용자가 바뀌면 저장한 목록과 사전을 버린다', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse([item('seoyoung', 'aaa')]));
  await useAgentPortraitStore.getState().activate(SERVER, JWT);

  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await useAgentPortraitStore.getState().activate(SERVER, jwtFor('other@test'));
  expect(useAgentPortraitStore.getState().ready).toBe(false);
  expect(useAgentPortraitStore.getState().dictionary.size).toBe(0);
  expect(useAgentPortraitStore.getState().etag).toBeNull();
  // 새 요청은 이전 ETag를 이어 쓰지 않는다.
  expect(fetchMock.mock.calls[1][1].headers['If-None-Match']).toBeUndefined();
  expect(await AsyncStorage.getItem(AGENT_PORTRAIT_STORAGE_KEY)).toBeNull();

  // 앱을 다시 켠 뒤 다른 서버로 시작해도 저장한 목록을 쓰지 않는다.
  await AsyncStorage.setItem(AGENT_PORTRAIT_STORAGE_KEY, JSON.stringify({
    scope: agentPortraitScope(SERVER, JWT), etag: '"stored"', portraits: [item('seoyoung', 'old')],
  }));
  useAgentPortraitStore.getState().deactivate();
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  await useAgentPortraitStore.getState().activate('https://other.test', JWT);
  expect(useAgentPortraitStore.getState().ready).toBe(false);
  expect(await AsyncStorage.getItem(AGENT_PORTRAIT_STORAGE_KEY)).toBeNull();
});

test('사전이 준비되기 전에는 원래 주소를 쓰고, 준비된 뒤에는 버전 주소로 바꾼다', async () => {
  const before = createAgentPortraitResolver(useAgentPortraitStore.getState().dictionary, false);
  expect(before.normalize('/api/nodes/n1/agents/seoyoung/portrait')).toBe('/api/nodes/n1/agents/seoyoung/portrait');
  expect(before.forAgent('seoyoung')).toBe('/api/agents/seoyoung/portrait');
  expect(before.forSession(null, 'seoyoung')).toBe('/api/agents/seoyoung/portrait');
  expect(before.forAgent(null)).toBe('');

  fetchMock.mockResolvedValueOnce(jsonResponse([item('seoyoung', 'aaa')]));
  await useAgentPortraitStore.getState().activate(SERVER, JWT);
  const { dictionary, ready } = useAgentPortraitStore.getState();
  const after = createAgentPortraitResolver(dictionary, ready);
  expect(after.normalize('/api/nodes/n1/agents/seoyoung/portrait')).toBe('/api/agent-portraits/seoyoung?v=aaa');
  expect(after.normalize(`${SERVER}/api/nodes/n2/agents/seoyoung/portrait`)).toBe(`${SERVER}/api/agent-portraits/seoyoung?v=aaa`);
  expect(after.normalize('https://lh3.googleusercontent.com/a.png')).toBe('https://lh3.googleusercontent.com/a.png');
  expect(after.normalize('/api/nodes/n1/agents/unknown/portrait')).toBe('');
  expect(after.forAgent('seoyoung')).toBe('/api/agent-portraits/seoyoung?v=aaa');
  expect(after.forSession('/api/nodes/n1/agents/seoyoung/portrait', 'seoyoung')).toBe('/api/agent-portraits/seoyoung?v=aaa');
});

describe('useAgentPortraitSync', () => {
  beforeEach(() => {
    useSettingsStore.setState({ serverUrl: SERVER });
    useAuthStore.setState({ jwt: JWT });
  });

  test('로그인된 상태에서 한 번 받고, 앱이 active로 돌아오면 60초 제한 안에서 다시 받는다', async () => {
    fetchMock.mockResolvedValue(jsonResponse([item('seoyoung', 'aaa')]));
    const hook = renderHook(() => useAgentPortraitSync());
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fire = (next: string) => (globalThis as unknown as { __appStateListeners: Array<(s: string) => void> }).__appStateListeners.forEach((fn) => fn(next));

    await act(async () => { fire('active'); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    jest.setSystemTime(1_000_000 + AGENT_PORTRAIT_FOREGROUND_REFRESH_MS + 1);
    await act(async () => { fire('background'); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { fire('active'); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    hook.unmount();
    expect(AppState.addEventListener).toHaveBeenCalled();
  });

  test('로그인하지 않았으면 받지 않고 사전을 비운다', async () => {
    useAuthStore.setState({ jwt: null });
    renderHook(() => useAgentPortraitSync());
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAgentPortraitStore.getState().ready).toBe(false);
  });
});
