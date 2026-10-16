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
