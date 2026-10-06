import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';

const BASE = 'https://soul.test';
const instruction = {
  id: 'instruction/1', text: 'Keep the requested scope.', source_turns: ['T195'],
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', origin: 'user',
};

function response(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? 'Conflict' : 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body,
    text: async () => text,
  } as Response;
}

beforeEach(() => useAuthStore.setState({ jwt: 'test-jwt', authRejected: false }));
afterEach(() => jest.restoreAllMocks());

test('reads, adds, updates and removes a persistent session instruction through the API client', async () => {
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ instructions: [instruction] }))
    .mockResolvedValueOnce(response({ instruction }, 201))
    .mockResolvedValueOnce(response({ instruction }))
    .mockResolvedValueOnce(response({ instruction: { ...instruction, status: 'removed' } }));
  const api = createApiClient(BASE);

  await expect(api.getPersistentSessionInstructions('pas/1')).resolves.toEqual({ instructions: [instruction] });
  await expect(api.createPersistentSessionInstruction('pas/1', 'Keep the requested scope.')).resolves.toEqual({ instruction });
  await expect(api.updatePersistentSessionInstruction('pas/1', 'instruction/1', { text: 'Updated scope.' })).resolves.toEqual({ instruction });
  await expect(api.updatePersistentSessionInstruction('pas/1', 'instruction/1', { status: 'removed' })).resolves.toEqual({ instruction: { ...instruction, status: 'removed' } });

  expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET', init?.body ?? null])).toEqual([
    [`${BASE}/api/persistent-sessions/pas%2F1/instructions`, 'GET', null],
    [`${BASE}/api/persistent-sessions/pas%2F1/instructions`, 'POST', JSON.stringify({ text: 'Keep the requested scope.' })],
    [`${BASE}/api/persistent-sessions/pas%2F1/instructions/instruction%2F1`, 'PUT', JSON.stringify({ text: 'Updated scope.' })],
    [`${BASE}/api/persistent-sessions/pas%2F1/instructions/instruction%2F1`, 'PUT', JSON.stringify({ status: 'removed' })],
  ]);
  for (const [, init] of fetchMock.mock.calls) {
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-jwt');
    if (init?.method) expect(headers.get('Content-Type')).toBe('application/json');
  }
});

test('preserves the cap_reached response for the settings action', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce(response({ error: 'cap_reached' }, 409));
  const api = createApiClient(BASE);

  await expect(api.createPersistentSessionInstruction('pas-1', 'Another rule.')).rejects.toMatchObject({
    status: 409,
    body: JSON.stringify({ error: 'cap_reached' }),
  });
});
