import {
  weeklyUsageGauges,
  type UsageSummaryGauge,
} from '../../../packages/soul-ui/src/lib/usage-summary';
import type { AppUsageSummaryNode, AppUsageSummaryProvider } from '../api/usageEndpoints';

export type AppUsageSummaryGauge = UsageSummaryGauge & {
  resetLabel?: string;
  poolFraction?: string;
  poolState?: 'normal' | 'partial' | 'blocked';
};

function localResetLabel(value: string | null): string {
  if (!value) return '해제';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '해제';
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${time} 해제`;
}

function asEpochSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

export function usageSummaryGaugesForApp(node: AppUsageSummaryNode | null): AppUsageSummaryGauge[] {
  if (!node) return [];
  const gauges: AppUsageSummaryGauge[] = weeklyUsageGauges(node);
  const claude = node.providers.claude as AppUsageSummaryProvider | null;
  const pool = claude?.mode === 'pool' ? claude.pool : null;
  if (!pool) return gauges;

  const poolFraction = pool.total_count >= 2 ? `${pool.available_count}/${pool.total_count}` : undefined;
  const poolState: AppUsageSummaryGauge['poolState'] = pool.available_count === 0
    ? 'blocked'
    : pool.available_count > 0 && pool.available_count < pool.total_count ? 'partial' : 'normal';
  const current = gauges.find(gauge => gauge.id === 'claude');
  if (pool.total_count > 0 && pool.available_count === 0) {
    const blocked: AppUsageSummaryGauge = {
      id: 'claude',
      label: 'Claude',
      poolFraction,
      poolState,
      remainingPercent: 0,
      resetAt: null,
      resetLabel: localResetLabel(pool.earliest_available_at),
    };
    return current ? gauges.map(gauge => gauge.id === 'claude' ? blocked : gauge) : [blocked, ...gauges];
  }

  const remainingPercent = current?.remainingPercent ?? pool.best_weekly_remaining_percent;
  if (remainingPercent === null || remainingPercent === undefined) return gauges;
  const resetAt = current?.resetAt ?? asEpochSeconds(pool.best_weekly_resets_at);
  const poolGauge: AppUsageSummaryGauge = { id: 'claude', label: 'Claude', poolFraction, poolState, remainingPercent, resetAt };
  return current
    ? gauges.map(gauge => gauge.id === 'claude' ? poolGauge : gauge)
    : [poolGauge, ...gauges];
}
