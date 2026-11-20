import { buildUsageStatsDayDetail, buildUsageStatsOverview } from '../../../packages/soul-ui/src/lib/usage-stats-fixtures';
import type { UsageStatsDayDetail, UsageStatsOverview, UsageStatsQuery } from '../../../packages/wire-schema/src/session_statistics';

/**
 * 카드 #1752 검수용: 세션 통계 화면은 overview가 있어야 보기·측정·캐시 제어 줄을 그린다.
 * 검수 번들은 노드에 닿지 않으므로 소울UI 공개 픽스처로 만든 운영 형태 응답을 끼운다.
 */
export function createUsageStatsReviewApi() {
  return {
    getSessionStatistics: async (query: UsageStatsQuery): Promise<UsageStatsOverview> => buildUsageStatsOverview(query),
    getSessionStatisticsDay: async (date: string, query: UsageStatsQuery): Promise<UsageStatsDayDetail> => {
      const roster = buildUsageStatsOverview(query).by_project
        .flatMap(row => row.project_id && row.project_id !== '__other__' ? [row.project_id] : []);
      return buildUsageStatsDayDetail(date, query, roster);
    },
  };
}
