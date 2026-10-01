import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';

const BASE = 'http://test.example';

function response(body: unknown, status = 200): Partial<Response> {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Conflict',
    json: async () => body,
    text: async () => text,
    headers: new Headers({ 'Content-Type': 'application/json' }),
  };
}

beforeEach(() => {
  useAuthStore.setState({ jwt: 'test-jwt', authRejected: false });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('resume-after-limit GET and POST keep the server wire contract', async () => {
  const getBody = {
    eligible: true,
    reason: null,
    resets_at: '2026-09-28T09:00:00.000Z',
    schedule: null,
  };
  const postBody = {
    schedule_id: 'schedule-1',
    run_at: '2026-09-28T09:00:00.000Z',
    status: 'active',
    reused: false,
  };
  const fetchMock = jest.fn()
    .mockResolvedValueOnce(response(getBody))
    .mockResolvedValueOnce(response(postBody));
  (global as any).fetch = fetchMock;
  const api = createApiClient(BASE);

  await expect(api.getResumeAfterLimit('session/a')).resolves.toEqual(getBody);
  await expect(api.scheduleResumeAfterLimit('session/a')).resolves.toEqual(postBody);

  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    `${BASE}/api/sessions/session%2Fa/resume-after-limit`,
    `${BASE}/api/sessions/session%2Fa/resume-after-limit`,
  ]);
  const get = fetchMock.mock.calls[0][1] as RequestInit;
  expect(get.method).toBeUndefined();
  expect(get.body).toBeUndefined();
  const post = fetchMock.mock.calls[1][1] as RequestInit;
  expect(post.method).toBe('POST');
  expect(JSON.parse(post.body as string)).toEqual({});
  expect((post.headers as Headers).get('Content-Type')).toBe('application/json');
});

test('resume-after-limit forwards the existing API error body to callers', async () => {
  const fetchMock = jest.fn().mockResolvedValue(response({
    error: { code: 'RATE_LIMIT_RESET_UNAVAILABLE', message: 'reset unavailable' },
  }, 409));
  (global as any).fetch = fetchMock;
  const api = createApiClient(BASE);

  await expect(api.scheduleResumeAfterLimit('session-1'))
    .rejects.toThrow(/RATE_LIMIT_RESET_UNAVAILABLE/);
});
