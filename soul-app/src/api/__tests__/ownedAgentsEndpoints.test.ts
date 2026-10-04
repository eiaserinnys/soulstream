import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';

test('uses existing user auth and camelCase API without caller or owner fields; revoke accepts 204', async () => {
  useAuthStore.setState({ jwt: 'fake-user-jwt' });
  const request = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => ({
    ok: true, status: init?.method === 'DELETE' ? 204 : 200, headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => ({}), text: async () => '{}',
  }) as Response);
  const api = createApiClient('https://sample.invalid');
  try {
    await api.listOwnedAgents();
    await api.createOwnedAgent({ name: '내 도우미' });
    await api.updateOwnedAgent('a/1', { enabled: false });
    await api.registerExistingOwnedAgent();
    await api.issueOwnedAgentKey('a/1');
    await api.revokeOwnedAgentKey('a/1', 'k/1');
    expect(request.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['https://sample.invalid/api/owned-agents', 'GET'],
      ['https://sample.invalid/api/owned-agents', 'POST'],
      ['https://sample.invalid/api/owned-agents/a%2F1', 'PATCH'],
      ['https://sample.invalid/api/owned-agents/register-existing', 'POST'],
      ['https://sample.invalid/api/owned-agents/a%2F1/keys', 'POST'],
      ['https://sample.invalid/api/owned-agents/a%2F1/keys/k%2F1', 'DELETE'],
    ]);
    for (const [, init] of request.mock.calls) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fake-user-jwt');
      expect(init?.body ?? '').not.toMatch(/owner|caller|token/);
    }
  } finally { request.mockRestore(); useAuthStore.setState({ jwt: null }); }
});
