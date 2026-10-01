import { createApiRequestContext } from '../clientCore';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import {
  captureAuthScope,
  resetAuthScopeForTest,
} from '../../lib/auth-scope';

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock;
  useSettingsStore.setState({ serverUrl: 'https://server-a.test' });
  useAuthStore.setState({ jwt: 'jwt-a', authRejected: false });
  resetAuthScopeForTest();
  fetchMock.mockResolvedValue(new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
});

test('고정 auth request context는 store가 바뀌어도 시작 시 JWT를 계속 사용한다', async () => {
  const options = { authScope: captureAuthScope() };
  const context = createApiRequestContext('https://server-a.test', options);
  useAuthStore.setState({ jwt: 'jwt-b' });

  await context.authFetch('https://server-a.test/api/folders');

  const headers = new Headers(fetchMock.mock.calls[0][1].headers);
  expect(headers.get('Authorization')).toBe('Bearer jwt-a');
});

test('이전 고정 scope의 401은 새 scope JWT를 지우지 않는다', async () => {
  fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
  const context = createApiRequestContext('https://server-a.test', {
    authScope: captureAuthScope(),
  });
  useAuthStore.setState({ jwt: 'jwt-b' });

  await context.authFetch('https://server-a.test/api/folders');

  expect(useAuthStore.getState().jwt).toBe('jwt-b');
  expect(useAuthStore.getState().authRejected).toBe(false);
});

test('서버 전환 뒤 이전 서버의 401은 새 서버 로그인 상태를 지우지 않는다', async () => {
  let resolveOld!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveOld = resolve; }));
  const oldScope = captureAuthScope();
  const oldContext = createApiRequestContext(oldScope.serverUrl, { authScope: oldScope });
  const request = oldContext.authFetch(`${oldScope.serverUrl}/api/folders`);

  useSettingsStore.getState().setSettings('https://server-b.test', 'orchestrator');
  useAuthStore.getState().clear();
  useAuthStore.getState().setJwt('jwt-b');
  resolveOld(new Response('', { status: 401 }));
  await request;

  expect(useSettingsStore.getState().serverUrl).toBe('https://server-b.test');
  expect(useAuthStore.getState()).toMatchObject({ jwt: 'jwt-b', authRejected: false });
});

test('A→B→A로 JWT 원문이 같아져도 이전 A generation의 401은 현재 A를 지우지 않는다', async () => {
  let resolveOld!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveOld = resolve; }));
  const oldScope = captureAuthScope();
  const oldContext = createApiRequestContext('https://server-a.test', { authScope: oldScope });
  const request = oldContext.authFetch('https://server-a.test/api/folders');

  useAuthStore.getState().setJwt('jwt-b');
  useAuthStore.getState().setJwt('jwt-a');
  expect(captureAuthScope().generation).not.toBe(oldScope.generation);
  resolveOld(new Response('', { status: 401 }));
  await request;

  expect(useAuthStore.getState().jwt).toBe('jwt-a');
  expect(useAuthStore.getState().authRejected).toBe(false);
});

test('현재 generation의 401만 현재 인증을 지운다', async () => {
  fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
  const scope = captureAuthScope();
  const context = createApiRequestContext(scope.serverUrl, { authScope: scope });

  await context.authFetch(`${scope.serverUrl}/api/folders`);

  expect(useAuthStore.getState().jwt).toBeNull();
  expect(useAuthStore.getState().authRejected).toBe(true);
});

test('JWT 없이 시작한 현재 scope의 401도 인증 거부 상태로 전환한다', async () => {
  useAuthStore.setState({ jwt: null, authRejected: false });
  resetAuthScopeForTest();
  fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
  const scope = captureAuthScope();
  const context = createApiRequestContext(scope.serverUrl, { authScope: scope });

  await context.authFetch(`${scope.serverUrl}/api/folders`);

  expect(useAuthStore.getState().jwt).toBeNull();
  expect(useAuthStore.getState().authRejected).toBe(true);
});

test.each([403, 500])('현재 scope의 HTTP %i는 인증 거부 상태로 전환하지 않는다', async (status) => {
  fetchMock.mockResolvedValueOnce(new Response('', { status }));
  const scope = captureAuthScope();
  const context = createApiRequestContext(scope.serverUrl, { authScope: scope });

  await context.authFetch(`${scope.serverUrl}/api/folders`);

  expect(useAuthStore.getState().jwt).toBe('jwt-a');
  expect(useAuthStore.getState().authRejected).toBe(false);
});

test('네트워크 오류는 인증 거부 상태로 전환하지 않는다', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  const scope = captureAuthScope();
  const context = createApiRequestContext(scope.serverUrl, { authScope: scope });

  await expect(context.authFetch(`${scope.serverUrl}/api/folders`)).rejects.toThrow('offline');

  expect(useAuthStore.getState().jwt).toBe('jwt-a');
  expect(useAuthStore.getState().authRejected).toBe(false);
});
