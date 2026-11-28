import { useTranslation } from "react-i18next";
import { usageDate, usageNumber } from "./usage-format";
import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { FrameLoading, usageStatsBucketStarts, usageStatsCalendarRange, usageStatsSeriesKey } from "@seosoyoung/soul-ui";
import type { UsageStatsMetrics, UsageStatsPeriod, UsageStatsRange, UsageStatsSeriesPoint } from "../../../../packages/wire-schema/src/session_statistics";

export interface UsageChartSeries {
  key: string;
  label: string;
  color: string;
}

type Metric = "tokens" | "cost";

function metricValue(metrics: UsageStatsMetrics, metric: Metric): number | null {
  return metric === "tokens" ? metrics.total_tokens : metrics.reference_cost_usd;
}

function pointKey(point: UsageStatsSeriesPoint, kind: "provider" | "project", modelMode: boolean): string {
  if (kind === "project") return point.project_id ?? "__unclassified__";
  return usageStatsSeriesKey(point.provider ?? "unknown", point.model ?? null, modelMode);
}

function bucketLabel(bucket: string, period: UsageStatsPeriod, locale: string | undefined): string {
  if (period === "all") return usageDate(bucket, locale, { month: "short" });
  if (period === "week") return usageDate(bucket, locale, { weekday: "short" });
  const day = Number(bucket.slice(8, 10));
  return day === 1 || (day - 1) % 7 === 0 ? day.toLocaleString(locale) : "";
}

function isBeforeCoverage(bucket: string, period: UsageStatsPeriod, coveredSince: string): boolean {
  if (period === "all") {
    const monthEnd = usageStatsCalendarRange("month", bucket).until;
    return monthEnd <= coveredSince;
  }
  return bucket < coveredSince;
}

function isUnavailable(bucket: string, period: UsageStatsPeriod, range: UsageStatsRange | null, coveredSince: string | null): boolean {
  if (!range || !coveredSince) return true;
  return isBeforeCoverage(bucket, period, coveredSince) || bucket >= range.effective_until;
}

export function UsageStackedBars({
  label,
  kind,
  period,
  range,
  coveredSince,
  points,
  series,
  metric,
  selectedBucket,
  loading,
  emptyMessage,
  modelMode = false,
  onSelect,
}: {
  label: string;
  kind: "provider" | "project";
  period: UsageStatsPeriod;
  range: UsageStatsRange | null;
  coveredSince: string | null;
  points: readonly UsageStatsSeriesPoint[];
  series: readonly UsageChartSeries[];
  metric: Metric;
  selectedBucket: string | null;
  loading: boolean;
  emptyMessage: string | null;
  modelMode?: boolean;
  onSelect(bucket: string, intent: "toggle" | "set"): void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const unknownLabel = t(metric === "tokens" ? "admin.stats.missingUsage" : "admin.stats.unknownPrice");
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const drag = useRef<{ x: number; y: number; horizontal: boolean } | null>(null);
  const ignoreClick = useRef(false);
  const buckets = range ? usageStatsBucketStarts(range) : [];
  const visiblePoints = points.filter(point => kind === "provider" ? point.provider !== undefined : point.project_id !== undefined);
  const values = buckets.map(bucket => {
    const bucketPoints = visiblePoints.filter(point => point.bucket_start === bucket);
    const segments = series.map(item => {
      let value: number | null = null;
      for (const point of bucketPoints) {
        if (pointKey(point, kind, modelMode) !== item.key) continue;
        const nextValue = metricValue(point.metrics, metric);
        if (nextValue === null) continue;
        value = (value ?? 0) + nextValue;
      }
      return { ...item, value };
    });
    let total: number | null = null;
    for (const segment of segments) {
      if (segment.value !== null) total = (total ?? 0) + segment.value;
    }
    return { bucket, segments, total, hasPoint: bucketPoints.length > 0 };
  });
  const maximum = Math.max(0, ...values.map(item => item.total ?? 0));
  const hasKnownValue = values.some(item => item.total !== null);
  const activeIndex = Math.max(0, buckets.findIndex(bucket => bucket === selectedBucket));

  const bucketAtX = (clientX: number, rect: DOMRect): number => {
    if (buckets.length === 0 || rect.width <= 0) return -1;
    return Math.max(0, Math.min(buckets.length - 1, Math.floor(((clientX - rect.left) / rect.width) * buckets.length)));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const deltaX = event.clientX - drag.current.x;
    const deltaY = event.clientY - drag.current.y;
    if (!drag.current.horizontal && Math.abs(deltaX) < 6) return;
    if (Math.abs(deltaY) >= Math.abs(deltaX)) return;
    drag.current.horizontal = true;
    const index = bucketAtX(event.clientX, event.currentTarget.getBoundingClientRect());
    if (index >= 0 && !isUnavailable(buckets[index]!, period, range, coveredSince)) onSelect(buckets[index]!, "set");
  };

  return <div className="usage-stats-chart" aria-label={label}>
    {hasKnownValue && !emptyMessage && !loading ? <div className="usage-stats-axis-label" aria-hidden="true">{usageNumber(maximum, metric, locale)}</div> : null}
    {loading ? <div className="usage-stats-chart-message"><FrameLoading inline label={t("admin.stats.loading")} /></div> : emptyMessage ? (
      <div className="usage-stats-chart-message">{emptyMessage}</div>
    ) : !hasKnownValue ? (
      <div className="usage-stats-chart-message">{unknownLabel}</div>
    ) : null}
    <div className="usage-stats-chart-plot" role="group" aria-label={label} style={{ "--usage-stats-column-count": values.length } as CSSProperties} onKeyDownCapture={(event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || !selectedBucket) return;
      event.preventDefault();
      event.stopPropagation();
      onSelect("", "set");
    }} onPointerMove={onPointerMove} onPointerUp={() => {
      if (drag.current?.horizontal) {
        ignoreClick.current = true;
        window.setTimeout(() => { ignoreClick.current = false; }, 0);
      }
      drag.current = null;
    }} onPointerCancel={() => { drag.current = null; }}>
      {values.map((item, index) => {
        const unavailable = isUnavailable(item.bucket, period, range, coveredSince);
        const total = item.total;
        const height = maximum > 0 && total !== null ? (total / maximum) * 100 : 0;
        const partial = item.segments.some(segment => segment.value === null);
        const beforeCoverage = coveredSince !== null && isBeforeCoverage(item.bucket, period, coveredSince);
        const afterRange = range !== null && item.bucket >= range.effective_until;
        const accessibleValue = beforeCoverage ? t("admin.stats.beforeTracking") : afterRange ? t("admin.stats.notYetRecorded")
          : total === null || (total === 0 && partial) ? (item.hasPoint ? unknownLabel : t("admin.stats.noRecord")) : `${usageNumber(total, metric, locale)}${partial ? "+" : ""}`;
        const selected = selectedBucket === item.bucket;
        const disabled = unavailable || Boolean(emptyMessage);
        const description = usageDate(item.bucket, locale, period === "all"
          ? { year: "numeric", month: "short" }
          : { month: "short", day: "numeric", weekday: "short" });
        return <button
          key={item.bucket}
          ref={element => { buttons.current[index] = element; }}
          type="button"
          className={`usage-stats-chart-column${selected ? " is-selected" : ""}${unavailable ? " is-unavailable" : ""}`}
          data-bucket-index={index}
          aria-label={`${description}, ${accessibleValue}`}
          aria-pressed={selected}
          tabIndex={index === activeIndex && !disabled ? 0 : -1}
          disabled={disabled}
          onPointerDown={event => { drag.current = { x: event.clientX, y: event.clientY, horizontal: false }; }}
          onClick={() => {
            if (ignoreClick.current) { ignoreClick.current = false; return; }
            if (disabled) return;
            onSelect(item.bucket, "toggle");
          }}
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            let next = index + (event.key === "ArrowRight" ? 1 : -1);
            while (next >= 0 && next < values.length && isUnavailable(values[next]!.bucket, period, range, coveredSince)) {
              next += event.key === "ArrowRight" ? 1 : -1;
            }
            if (next < 0 || next >= values.length) return;
            buttons.current[next]?.focus();
            onSelect(values[next]!.bucket, "set");
          }}
        >
          <span className="usage-stats-column-band" aria-hidden="true" />
          {total !== null && total > 0 ? <span className="usage-stats-stack" style={{ height: `${height}%` }} aria-hidden="true">
            {item.segments.map(segment => segment.value === null || segment.value === 0 ? null : <span
              key={segment.key}
              className="usage-stats-stack-segment"
              style={{ height: `${(segment.value / total) * 100}%`, backgroundColor: segment.color }}
            />)}
          </span> : null}
        </button>;
      })}
    </div>
    <div className="usage-stats-chart-labels" aria-hidden="true" style={{ "--usage-stats-column-count": values.length } as CSSProperties}>
      {hasKnownValue && !emptyMessage && !loading ? <span className="usage-stats-axis-zero">0</span> : null}
      {values.map(item => <span key={item.bucket} className="usage-stats-bucket-label" style={{ opacity: isUnavailable(item.bucket, period, range, coveredSince) ? 0.48 : 1 }}>{bucketLabel(item.bucket, period, locale)}</span>)}
    </div>
  </div>;
}
