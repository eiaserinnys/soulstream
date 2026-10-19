import { formatUsageStatsDateWithWeekday } from '../../../../../packages/soul-ui/src/lib/usage-stats-format';
import type {
  UsageStatsPeriod,
  UsageStatsProvider,
  UsageStatsRange,
  UsageStatsSeriesPoint,
} from '../../../../../packages/soul-ui/src/lib/usage-stats-fixture-data';
import type { UsageStackBucket } from './UsageStackedBars';

type Measure = 'tokens' | 'cost';

export function makeUsageStatsBuckets(
  points: UsageStatsSeriesPoint[],
  period: UsageStatsPeriod,
  range: UsageStatsRange,
  measure: Measure,
  kind: 'model' | 'project',
  seriesColors: Record<UsageStatsProvider, string>,
  projectColorById: Record<string, string>,
  fallbackColor: string,
  coveredSince: string,
  emptyData: boolean,
  modelColorById?: Record<string, string>,
): UsageStackBucket[] {
  const grouped: Record<string, UsageStackBucket> = {};
  for (const bucketStart of bucketStarts(period, range)) {
    const id = `${period === 'all' ? 'month' : 'day'}-${bucketStart}`;
    const availability = bucketAvailability(bucketStart, period, range, coveredSince);
    grouped[bucketStart] = {
      id,
      label: bucketLabel(bucketStart, period),
      description: bucketDescription(bucketStart, period),
      segments: [],
      selectable: !emptyData && availability === 'available',
      availability,
    };
  }

  for (const point of points) {
    const bucket = grouped[point.bucket_start];
    if (!bucket) continue;
    const identity = kind === 'model'
      ? `${point.provider ?? '__unknown__'}:${point.model ?? ''}`
      : `project:${point.project_id ?? '__unclassified__'}`;
    const value = point.metrics[measure === 'tokens' ? 'total_tokens' : 'reference_cost_usd'];
    const color = kind === 'model'
      ? modelColorById ? (point.model ? modelColorById[point.model] : undefined) ?? fallbackColor : point.provider ? seriesColors[point.provider] : fallbackColor
      : point.project_id && point.project_id !== '__other__' ? projectColorById[point.project_id] ?? fallbackColor : fallbackColor;
    const existing = bucket.segments.find(segment => segment.id === identity);
    if (existing) {
      const prior = existing.value;
      existing.partial = existing.partial || prior === null || value === null;
      const known = [prior, value].flatMap(item => typeof item === 'number' ? [item] : []);
      existing.value = known.length === 0 ? null : known.reduce((sum, item) => sum + item, 0);
    } else {
      bucket.segments.push({ id: identity, label: point.label, value, color, partial: false });
    }
  }
  return Object.values(grouped);
}

export function sumKnown(values: (number | null)[]): number {
  return values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
}

function bucketStarts(period: UsageStatsPeriod, range: UsageStatsRange): string[] {
  const buckets: string[] = [];
  if (period === 'all') {
    const start = new Date(`${range.since}T00:00:00Z`);
    const end = new Date(`${range.effective_until}T00:00:00Z`);
    let year = start.getUTCFullYear();
    let month = start.getUTCMonth();
    while (year < end.getUTCFullYear() || (year === end.getUTCFullYear() && month <= end.getUTCMonth())) {
      buckets.push(`${year}-${String(month + 1).padStart(2, '0')}-01`);
      month += 1;
      if (month > 11) { month = 0; year += 1; }
    }
    return buckets;
  }

  const cursor = new Date(`${range.since}T00:00:00Z`);
  const until = new Date(`${range.until}T00:00:00Z`);
  while (cursor < until) {
    buckets.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return buckets;
}

function bucketLabel(bucket: string, period: UsageStatsPeriod): string {
  if (period === 'all') return `${Number(bucket.slice(5, 7))}월`;
  const date = new Date(`${bucket}T00:00:00Z`);
  if (period === 'week') return ['일', '월', '화', '수', '목', '금', '토'][date.getUTCDay()];
  const day = date.getUTCDate();
  return day === 1 || (day - 1) % 7 === 0 ? String(day) : '';
}

function bucketDescription(bucket: string, period: UsageStatsPeriod): string {
  if (period === 'all') {
    const date = new Date(`${bucket}T00:00:00Z`);
    return `${date.getUTCFullYear()}년 ${date.getUTCMonth() + 1}월`;
  }
  return formatUsageStatsDateWithWeekday(bucket);
}

function bucketAvailability(
  bucket: string,
  period: UsageStatsPeriod,
  range: UsageStatsRange,
  coveredSince: string,
): UsageStackBucket['availability'] {
  if (period === 'all') {
    const monthEnd = new Date(`${bucket}T00:00:00Z`);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
    if (monthEnd.toISOString().slice(0, 10) <= coveredSince) return 'before-coverage';
    if (bucket >= range.effective_until) return 'future';
    return 'available';
  }
  if (bucket < coveredSince) return 'before-coverage';
  if (bucket >= range.effective_until) return 'future';
  return 'available';
}

