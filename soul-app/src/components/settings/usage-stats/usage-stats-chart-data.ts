import { formatUsageStatsDateWithWeekday, usageStatsBucketStarts } from '../../../../../packages/soul-ui/src/lib/usage-stats-format';
import { usageStatsSeriesKey } from '../../../../../packages/soul-ui/src/lib/usage-stats-presentation';
import type {
  UsageStatsPeriod,
  UsageStatsProvider,
  UsageStatsRange,
  UsageStatsSeriesPoint,
} from '../../../../../packages/wire-schema/src/session_statistics';
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
  modelColorById?: Record<string, string>,
): UsageStackBucket[] {
  const grouped: Record<string, UsageStackBucket> = {};
  const bucketsWithUnknown = new Set<string>();
  for (const bucketStart of usageStatsBucketStarts(range)) {
    const id = `${period === 'all' ? 'month' : 'day'}-${bucketStart}`;
    const availability = bucketAvailability(bucketStart, period, range, coveredSince);
    grouped[bucketStart] = {
      id,
      label: bucketLabel(bucketStart, period),
      description: bucketDescription(bucketStart, period),
      segments: [],
      selectable: availability === 'available',
      availability,
    };
  }

  for (const point of points) {
    const bucket = grouped[point.bucket_start];
    if (!bucket) continue;
    const identity = kind === 'model'
      ? usageStatsSeriesKey(point.provider ?? 'unknown', point.model ?? null, true)
      : `project:${point.project_id ?? '__unclassified__'}`;
    const value = point.metrics[measure === 'tokens' ? 'total_tokens' : 'reference_cost_usd'];
    const color = kind === 'model'
      ? modelColorById ? (point.model !== null && point.model !== undefined ? modelColorById[point.model] : undefined) ?? fallbackColor : point.provider ? seriesColors[point.provider] : fallbackColor
      : point.project_id && point.project_id !== '__other__' ? projectColorById[point.project_id] ?? fallbackColor : fallbackColor;
    if (value === null) bucketsWithUnknown.add(point.bucket_start);
    const existing = bucket.segments.find(segment => segment.id === identity);
    if (existing) {
      const prior = existing.value;
      const known = [prior, value].flatMap(item => typeof item === 'number' ? [item] : []);
      existing.value = known.length === 0 ? null : known.reduce((sum, item) => sum + item, 0);
    } else {
      bucket.segments.push({ id: identity, label: point.label, value, color });
    }
  }
  for (const [bucketStart, bucket] of Object.entries(grouped)) {
    const known = bucket.segments.flatMap(segment => typeof segment.value === 'number' ? [segment.value] : []);
    if (known.some(value => value > 0)) {
      bucket.segments = bucket.segments.filter(segment => segment.value !== null);
      if (bucket.availability === 'before-coverage') {
        bucket.availability = 'available';
        bucket.selectable = true;
      }
    } else if (bucketsWithUnknown.has(bucketStart)) {
      for (const segment of bucket.segments) segment.value = null;
    }
  }
  return Object.values(grouped);
}

export function sumKnown(values: (number | null)[]): number {
  return values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
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

