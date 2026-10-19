import { buildEmptyUsageStatsOverview, buildUsageStatsDayDetail, buildUsageStatsOverview } from '../../../packages/soul-ui/src/lib/usage-stats-fixtures';
import type { UsageStatsProvider, UsageStatsQuery } from '../../../packages/wire-schema/src/session_statistics';

export type UsageStatsMockState = 'ready' | 'loading' | 'empty' | 'error' | 'forbidden' | 'backfilling';

// Tests exercise the real client and endpoint methods through this fetch transport.
export function createUsageStatsMockFetch(state: UsageStatsMockState, fallback: typeof fetch): typeof fetch {
  let failureInjected = false;
  return async (input, init) => {
    const url = new URL(String(input), 'https://usage-stats.mock');
    if (!url.pathname.startsWith('/api/session-statistics')) return fallback(input, init);
    if (state === 'loading') return new Promise<Response>(() => {});
    if (state === 'forbidden') return response({ error: 'forbidden' }, 403);
    if (state === 'error' && !failureInjected) {
      failureInjected = true;
      return response({ error: 'unavailable' }, 503);
    }
    const query: UsageStatsQuery = {
      period: url.searchParams.get('period') as UsageStatsQuery['period'],
      anchor: url.searchParams.get('anchor')!,
      provider: url.searchParams.get('provider') as UsageStatsProvider | null,
      model: url.searchParams.get('model'),
      project_ids: url.searchParams.get('project_ids')?.split(',') ?? [],
    };
    const date = url.pathname.match(/\/days\/(\d{4}-\d{2}-\d{2})$/)?.[1];
    if (date) {
      const base = buildUsageStatsOverview({ period: query.period, anchor: query.anchor });
      const roster = base.by_project.flatMap(row => row.project_id && row.project_id !== '__other__' ? [row.project_id] : []);
      return response(buildUsageStatsDayDetail(date, query, roster));
    }
    const overview = state === 'empty' ? buildEmptyUsageStatsOverview(query) : buildUsageStatsOverview(query);
    if (state === 'backfilling') overview.projection_status.state = 'backfilling';
    return response(overview);
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
