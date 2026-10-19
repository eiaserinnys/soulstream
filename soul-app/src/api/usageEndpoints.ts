import type { UsageSummarySnapshot } from '../../../packages/soul-ui/src/lib/usage-summary';
import type { UsageStatsQuery, UsageStatsOverview, UsageStatsDayDetail } from '../../../packages/soul-ui/src/lib/usage-stats-fixture-data';

import type { ApiRequestContext } from './clientCore';

export function createUsageEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  const statisticsQuery = (query: UsageStatsQuery) => new URLSearchParams({
    period: query.period,
    anchor: query.anchor,
    timezone: 'Asia/Seoul',
    ...(query.provider ? { provider: query.provider } : {}),
    ...(query.model ? { model: query.model } : {}),
    ...(query.project_ids?.length ? { project_ids: query.project_ids.join(',') } : {}),
  }).toString();
  return {
    getSessionStatistics: (query: UsageStatsQuery): Promise<UsageStatsOverview> =>
      authFetch(`${base}/api/session-statistics?${statisticsQuery(query)}`)
        .then(response => readJson<UsageStatsOverview>(response, 'getSessionStatistics')),
    getSessionStatisticsDay: (date: string, query: UsageStatsQuery): Promise<UsageStatsDayDetail> =>
      authFetch(`${base}/api/session-statistics/days/${encodeURIComponent(date)}?${statisticsQuery(query)}`)
        .then(response => readJson<UsageStatsDayDetail>(response, 'getSessionStatisticsDay')),
    getUsageSummary: (): Promise<UsageSummarySnapshot> =>
      authFetch(`${base}/api/usage/summary`)
        .then((response) => readJson<UsageSummarySnapshot>(response, 'getUsageSummary')),
  };
}
