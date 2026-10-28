import type {
  ClaudeAccount,
  ClaudeAccountPool,
  UsageSummaryNode,
  UsageSummaryProvider,
  UsageSummarySnapshot,
} from '../../../packages/soul-ui/src/lib/usage-summary';
import type { UsageStatsQuery, UsageStatsOverview, UsageStatsDayDetail } from '../../../packages/wire-schema/src/session_statistics';

import type { ApiRequestContext } from './clientCore';

export type AppUsageSummaryProvider = UsageSummaryProvider & {
  readonly mode?: 'legacy' | 'pool';
  readonly accounts?: readonly ClaudeAccount[];
  readonly pool?: ClaudeAccountPool | null;
  readonly fable_pool?: ClaudeAccountPool | null;
};

export type AppUsageSummaryNode = Omit<UsageSummaryNode, 'providers'> & {
  readonly providers: Omit<UsageSummaryNode['providers'], 'claude'> & {
    readonly claude: AppUsageSummaryProvider | null;
  };
};

export type AppUsageSummarySnapshot = Omit<UsageSummarySnapshot, 'nodes'> & {
  readonly nodes: readonly AppUsageSummaryNode[];
};

export function createUsageEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  const statisticsQuery = (query: UsageStatsQuery) => new URLSearchParams({
    period: query.period,
    anchor: query.anchor,
    timezone: 'Asia/Seoul',
    ...(query.provider ? { provider: query.provider } : {}),
    ...(query.model !== undefined && query.model !== null ? { model: query.model } : {}),
    ...(query.project_ids?.length ? { project_ids: query.project_ids.join(',') } : {}),
  }).toString();
  return {
    getSessionStatistics: (query: UsageStatsQuery): Promise<UsageStatsOverview> =>
      authFetch(`${base}/api/session-statistics?${statisticsQuery(query)}`)
        .then(response => readJson<UsageStatsOverview>(response, 'getSessionStatistics')),
    getSessionStatisticsDay: (date: string, query: UsageStatsQuery): Promise<UsageStatsDayDetail> =>
      authFetch(`${base}/api/session-statistics/days/${encodeURIComponent(date)}?${statisticsQuery(query)}`)
        .then(response => readJson<UsageStatsDayDetail>(response, 'getSessionStatisticsDay')),
    getUsageSummary: (): Promise<AppUsageSummarySnapshot> =>
      authFetch(`${base}/api/usage/summary`)
        .then((response) => readJson<AppUsageSummarySnapshot>(response, 'getUsageSummary')),
  };
}
