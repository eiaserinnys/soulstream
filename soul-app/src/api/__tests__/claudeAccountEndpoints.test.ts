import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import type { ClaudeAccountDeleteResult, ClaudeAccountList } from '../../../../packages/soul-ui/src/lib/usage-summary';

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

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://accounts.example' });
  useAuthStore.setState({ jwt: 'accounts-jwt' });
  (global as any).fetch = jest.fn().mockResolvedValue(jsonResponse({ mode: 'pool' }));
});

test('account list and PATCH use the authenticated Claude pool contract', async () => {
  const api = createApiClient('https://accounts.example');
  await api.getClaudeAuthAccounts('node/a');
  await api.patchClaudeAuthAccount('node/a', 'account/1', { priority: 2 });

  const calls = (global.fetch as jest.Mock).mock.calls as [string, RequestInit][];
  expect(calls.map(([url]) => url)).toEqual([
    'https://accounts.example/api/nodes/node%2Fa/claude-auth/accounts',
    'https://accounts.example/api/nodes/node%2Fa/claude-auth/accounts/account%2F1',
  ]);
  expect(calls[1]?.[1].method).toBe('PATCH');
  expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ priority: 2 });
  expect((calls[0]?.[1].headers as Headers).get('Authorization')).toBe('Bearer accounts-jwt');
});

test('delete and login flow endpoints carry only their contract fields', async () => {
  const api = createApiClient('https://accounts.example');
  await api.deleteClaudeAuthAccount('node-a', 'account-a');
  await api.startClaudeAuthLogin('node-a', 'account-a');
  await api.getClaudeAuthLogin('node-a', 'login-a');
  await api.submitClaudeAuthLoginCode('node-a', 'login-a', 'x');
  await api.cancelClaudeAuthLogin('node-a', 'login-a');

  const calls = (global.fetch as jest.Mock).mock.calls as [string, RequestInit][];
  expect(calls.map(([url, init]) => [new URL(url).pathname, init.method ?? 'GET'])).toEqual([
    ['/api/nodes/node-a/claude-auth/accounts/account-a', 'DELETE'],
    ['/api/nodes/node-a/claude-auth/logins', 'POST'],
    ['/api/nodes/node-a/claude-auth/logins/login-a', 'GET'],
    ['/api/nodes/node-a/claude-auth/logins/login-a/code', 'POST'],
    ['/api/nodes/node-a/claude-auth/logins/login-a', 'DELETE'],
  ]);
  expect(calls[0]?.[1].body).toBeUndefined();
  expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ account_id: 'account-a' });
  expect(JSON.parse(String(calls[3]?.[1].body))).toEqual({ code: 'x' });
});

test('account DELETE keeps its P6 response and GET keeps both pool summaries', async () => {
  const pool = {
    available_count: 1,
    total_count: 2,
    best_weekly_remaining_percent: 80,
    best_weekly_resets_at: null,
    earliest_available_at: null,
  };
  const deleted: ClaudeAccountDeleteResult = { deferred: false, accounts: [], pool };
  const refreshed: ClaudeAccountList = {
    mode: 'pool',
    accounts: [],
    pool,
    fable_pool: { ...pool, available_count: 0, best_weekly_remaining_percent: 12 },
  };
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce(jsonResponse(deleted))
    .mockResolvedValueOnce(jsonResponse(refreshed));
  const api = createApiClient('https://accounts.example');

  await expect(api.deleteClaudeAuthAccount('node-a', 'account-a')).resolves.toEqual(deleted);
  await expect(api.getClaudeAuthAccounts('node-a')).resolves.toEqual(refreshed);
});
