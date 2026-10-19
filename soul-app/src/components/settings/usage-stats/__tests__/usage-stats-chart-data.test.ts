import {
  buildUsageStatsOverview,
  USAGE_STATS_FIXTURE_ANCHOR,
} from '../../../../../../packages/soul-ui/src/lib/usage-stats-fixtures';
import type { UsageStatsPeriod, UsageStatsProvider } from '../../../../../../packages/soul-ui/src/lib/usage-stats-fixture-data';
import { makeUsageStatsBuckets } from '../usage-stats-chart-data';

const providerColors: Record<UsageStatsProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  antigravity: 'antigravity',
  deepseek: 'deepseek',
  kimi: 'kimi',
};

function bucketsFor(period: UsageStatsPeriod, anchor: string) {
  const overview = buildUsageStatsOverview({ period, anchor });
  const points = overview.series.filter(point => point.provider !== undefined && point.project_id === undefined);
  return makeUsageStatsBuckets(
    points,
    period,
    overview.range,
    'tokens',
    'model',
    providerColors,
    {},
    'muted',
    overview.projection_status.covered_since,
    false,
  );
}

test('주간과 월간은 기록이 없는 날짜도 균등한 기간 칸으로 만든다', () => {
  const week = bucketsFor('week', USAGE_STATS_FIXTURE_ANCHOR);
  const month = bucketsFor('month', USAGE_STATS_FIXTURE_ANCHOR);

  expect(week.map(bucket => bucket.id)).toEqual([
    'day-2026-10-12', 'day-2026-10-13', 'day-2026-10-14', 'day-2026-10-15',
    'day-2026-10-16', 'day-2026-10-17', 'day-2026-10-18',
  ]);
  expect(month).toHaveLength(31);
  expect(month[17].availability).toBe('available');
  expect(month[18].availability).toBe('future');
  expect(month[18].selectable).toBe(false);
});

test('전체 보기는 월별 칸을 만들고 기록 전 주간은 모두 비활성이다', () => {
  const all = bucketsFor('all', USAGE_STATS_FIXTURE_ANCHOR);
  const beforeCoverage = bucketsFor('week', '2026-08-16');

  expect(all.map(bucket => bucket.id)).toEqual(['month-2026-09-01', 'month-2026-10-01']);
  expect(beforeCoverage.every(bucket => bucket.availability === 'before-coverage' && !bucket.selectable)).toBe(true);
});
test('실제 DeepSeek 필터 응답은 금요일의 미기록 포인트를 보존한다', () => {
  const overview = buildUsageStatsOverview({ period: 'week', anchor: '2026-10-17', provider: 'deepseek' });
  const friday = overview.series.filter(point => point.provider === 'deepseek' && point.bucket_start === '2026-10-16');
  expect(friday.length).toBeGreaterThan(0);
  expect(friday.every(point => point.metrics.total_tokens === null)).toBe(true);
});
