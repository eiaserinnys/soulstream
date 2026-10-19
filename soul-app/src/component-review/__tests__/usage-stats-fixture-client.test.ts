import { createApiClient } from '../fixture-client';
import { useAuthStore } from '../../store/authStore';
import { createUsageStatsMockFetch } from '../../mockups/usage-stats-485/mock-api';

const originalFetch = global.fetch;

beforeEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: { search: '?state=error' } });
  useAuthStore.setState({ jwt: 'public-fixture-token' });
  global.fetch = jest.fn(createUsageStatsMockFetch('error', originalFetch));
});
afterEach(() => { global.fetch = originalFetch; });

test('Metro alias 대상 client도 인증 요청을 보내고 실패·재시도·날짜 응답을 그대로 전달한다', async () => {
  const client = createApiClient('https://usage-stats.mock');
  const query = { period: 'week' as const, anchor: '2026-10-17', provider: 'codex' as const, model: 'gpt-6-luna', project_ids: ['project-experiments'] };
  await expect(client.getSessionStatistics(query)).rejects.toMatchObject({ name: 'ApiHttpError', status: 503 });
  await expect(client.getSessionStatistics(query)).resolves.toMatchObject({
    range: { timezone: 'Asia/Seoul', period: 'week' },
    by_model: [expect.objectContaining({ provider: 'codex', model: 'gpt-6-luna' })],
  });
  await expect(client.getSessionStatisticsDay('2026-10-15', query)).resolves.toMatchObject({
    date: '2026-10-15', totals: { metrics: { total_tokens: null, reference_cost_usd: null } },
  });
  const calls = (global.fetch as jest.Mock).mock.calls as [string, RequestInit][];
  expect(calls).toHaveLength(3);
  expect(calls[0][0]).toBe(calls[1][0]);
  expect(new URL(calls[2][0]).pathname).toBe('/api/session-statistics/days/2026-10-15');
  for (const [url, init] of calls) {
    expect(new URL(url).searchParams.get('model')).toBe('gpt-6-luna');
    expect(new URL(url).searchParams.get('project_ids')).toBe('project-experiments');
    expect(new URL(url).searchParams.get('timezone')).toBe('Asia/Seoul');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer public-fixture-token');
  }
});
