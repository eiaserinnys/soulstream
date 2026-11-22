import { buildEmptyUsageStatsOverview, buildUsageStatsDayDetail, buildUsageStatsOverview } from '../../../packages/soul-ui/src/lib/usage-stats-fixtures';
import type { UsageStatsProvider, UsageStatsQuery } from '../../../packages/wire-schema/src/session_statistics';

export type UsageStatsMockState = 'ready' | 'loading' | 'empty' | 'error' | 'forbidden' | 'backfilling';

// Tests exercise the real client and endpoint methods through this fetch transport.
export function trackUsageStatsResponse<T>(pending: Promise<unknown>[] | undefined, promise: Promise<T>): Promise<T> {
  pending?.push(promise);
  return promise;
}

export function createUsageStatsMockFetch(
  state: UsageStatsMockState,
  fallback: typeof fetch,
  pending?: Promise<unknown>[],
): typeof fetch {
  let failureInjected = false;
  return (input, init) => {
    const url = new URL(String(input), 'https://usage-stats.mock');
    if (!url.pathname.startsWith('/api/session-statistics')) return fallback(input, init);
    if (state === 'loading') return new Promise<Response>(() => {});
    if (state === 'forbidden') return trackUsageStatsResponse(pending, Promise.resolve(response({ error: 'forbidden' }, 403)));
    if (state === 'error' && !failureInjected) {
      failureInjected = true;
      return trackUsageStatsResponse(pending, Promise.resolve(response({ error: 'unavailable' }, 503)));
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
      return trackUsageStatsResponse(pending, Promise.resolve(response(buildUsageStatsDayDetail(date, query, roster))));
    }
    const overview = state === 'empty' ? buildEmptyUsageStatsOverview(query) : buildUsageStatsOverview(query);
    if (state === 'backfilling') overview.projection_status.state = 'backfilling';
    return trackUsageStatsResponse(pending, Promise.resolve(response(overview)));
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
