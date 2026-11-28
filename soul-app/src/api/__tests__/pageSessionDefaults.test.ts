import { createApiClient } from '../client';
import { useAuthStore } from '../../store/authStore';

const BASE = 'https://planner.test';

function response(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => useAuthStore.setState({ jwt: 'planner-jwt' }));
afterEach(() => jest.restoreAllMocks());

test('기본 실행 환경의 물려받은 값은 서버 session-defaults 해석을 그대로 읽는다', async () => {
  const resolved = { agentId: 'roselin', nodeId: 'eiaserinnys', modelPreset: null, sourcePageId: 'root-page', sourceBlockId: 'b1' };
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response(resolved))
    .mockResolvedValueOnce(response(null));
  const api = createApiClient(BASE);
  await expect(api.getPageSessionDefaults('page/1')).resolves.toEqual(resolved);
  await expect(api.getPageSessionDefaults('page-2')).resolves.toBeNull();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    `${BASE}/api/pages/page%2F1/session-defaults`,
    `${BASE}/api/pages/page-2/session-defaults`,
  ]);
});
