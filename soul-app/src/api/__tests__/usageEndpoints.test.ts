import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as Response;
}

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://usage.example' });
  useAuthStore.setState({ jwt: 'usage-jwt' });
  (global as any).fetch = jest.fn().mockResolvedValue(jsonResponse({
    generatedAt: '2026-10-11T00:00:00.000Z',
    collectedAt: null,
    nodes: [],
  }));
});

test('facade GET reuses the authenticated usage summary request context', async () => {
  const api = createApiClient('https://usage.example');

  await expect(api.getUsageSummary()).resolves.toMatchObject({ nodes: [] });
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://usage.example/api/usage/summary');
  expect((init.headers as Headers).get('Authorization')).toBe('Bearer usage-jwt');
});

test('404 status is preserved by the existing JSON error boundary', async () => {
  (global as any).fetch = jest.fn().mockResolvedValue(jsonResponse({ detail: 'pending' }, 404));

  await expect(createApiClient('https://usage.example').getUsageSummary()).rejects.toMatchObject({
    name: 'ApiHttpError',
    status: 404,
  });
});

test('statistics overview and day use the same authenticated query boundary', async () => {
  const api = createApiClient('https://usage.example');
  const query = { period: 'month' as const, anchor: '2026-10-17', provider: 'codex' as const, model: 'gpt-6-luna', project_ids: ['project-web-dashboard'] };
  await api.getSessionStatistics(query);
  await api.getSessionStatisticsDay('2026-10-16', query);
  const calls = (global.fetch as jest.Mock).mock.calls as [string, RequestInit][];
  expect(new URL(calls[0][0]).pathname).toBe('/api/session-statistics');
  expect(new URL(calls[1][0]).pathname).toBe('/api/session-statistics/days/2026-10-16');
  for (const [url, init] of calls) {
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ ...query, project_ids: 'project-web-dashboard', timezone: 'Asia/Seoul' });
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer usage-jwt');
  }
});

test('model values containing separators and the literal null remain query values', async () => {
  const api = createApiClient('https://usage.example');
  for (const model of ['vendor:family/model', 'null']) {
    await api.getSessionStatistics({ period: 'week', anchor: '2026-10-17', provider: 'unknown', model });
  }
  const calls = (global.fetch as jest.Mock).mock.calls as [string, RequestInit][];
  expect(calls.map(([url]) => new URL(url).searchParams.get('model'))).toEqual(['vendor:family/model', 'null']);
  expect(calls.map(([url]) => new URL(url).searchParams.get('provider'))).toEqual(['unknown', 'unknown']);
});
