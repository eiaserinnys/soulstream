import { useTranslation } from "react-i18next";
import { DashboardIconCap, weeklyUsedPercent, type UsageSummaryGauge } from "@seosoyoung/soul-ui";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { UseUsageSummaryResult } from "../hooks/useUsageSummary";

type Props = Pick<UseUsageSummaryResult, "node" | "gauges" | "loading" | "loadState" | "evaluatedAtMs"> & {
  onRetry: () => void;
  onNextNode: () => void;
};

type Translate = ReturnType<typeof useTranslation>["t"];

function emptyMessage({ loading, loadState, node, gauges }: Pick<Props, "loading" | "loadState" | "node" | "gauges">, t: Translate): string | null {
  if (gauges.length) return null;
  // 값 자리에 로딩 글자를 넣지 않는다. 첫 로딩 동안은 자리표시 행이 자리를 지킨다.
  if (loading) return null;
  if (loadState === "connectionError") return t("persistent.usage.error");
  if (node) return t("persistent.usage.noLimit");
  return t("persistent.usage.waiting");
}

type DisplayGauge = Omit<UsageSummaryGauge, "remainingPercent"> & { remainingPercent: number | null };

function localReleaseTime(value: string | null, t: Translate, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return t("persistent.usage.release", { time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date) });
}

function formatUsageCountdown(resetAt: number | null, now: number, locale: string) {
  if (resetAt === null) return null;
  const minutes = Math.max(0, Math.floor((resetAt - now / 1000) / 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const unit = (value: number, unit: "day" | "hour" | "minute", unitDisplay: "narrow" | "long") =>
    new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay }).format(value);
  if (days) return { compact: unit(days, "day", "narrow"), full: `${unit(days, "day", "long")} ${unit(hours % 24, "hour", "long")}` };
  const value = hours || minutes;
  const name = hours ? "hour" : "minute";
  return { compact: unit(value, name, "narrow"), full: unit(value, name, "long") };
}

function epochSeconds(value: string | null): number | null {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.trunc(milliseconds / 1000) : null;
}

export function PersistentSessionWeeklyUsage({ node, gauges, loading, loadState, evaluatedAtMs, onRetry, onNextNode }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const percentFormat = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const numberFormat = new Intl.NumberFormat(locale);
  const message = emptyMessage({ node, gauges, loading, loadState }, t);
  const claudeProvider = node?.providers.claude;
  const claudePool = claudeProvider?.mode === "pool" ? claudeProvider.pool : null;
  const showPoolCount = !!claudePool && claudePool.total_count >= 2;
  const fullyBlocked = showPoolCount && claudePool.available_count === 0;
  const releaseLabel = fullyBlocked ? localReleaseTime(claudePool?.earliest_available_at ?? null, t, locale) : null;
  const displayGauges: DisplayGauge[] = gauges.map(gauge => ({ ...gauge }));
  if (showPoolCount && !displayGauges.some(gauge => gauge.id === "claude")) {
    displayGauges.unshift({
      id: "claude",
      label: "Claude",
      remainingPercent: fullyBlocked ? 0 : claudePool.best_weekly_remaining_percent,
      resetAt: epochSeconds(claudePool.best_weekly_resets_at),
    });
  }
  const stale = loadState === "connectionError" && displayGauges.length > 0;
  const fetchedAt = stale && node?.fetchedAt ? Date.parse(node.fetchedAt) : NaN;
  const updatedLabel = Number.isFinite(fetchedAt)
    ? t("persistent.usage.lastUpdated", { time: new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(fetchedAt) })
    : t("persistent.usage.waitingUpdate");
  const placeholders = displayGauges.length === 0 ? 2 : 0;
  const placeholderRows = Array.from({ length: placeholders }, (_, index) => <div className="persistent-session-weekly-usage-row is-placeholder" aria-hidden="true" key={`placeholder-${index}`}>
    <div className="persistent-session-weekly-usage-labels persistent-session-weekly-usage-placeholder-labels" />
    <div className="persistent-session-weekly-usage-track" />
  </div>);

  return <div
    className="persistent-session-weekly-usage"
    role="group"
    aria-label={t("persistent.usage.title")}
    title={stale && updatedLabel ? t("persistent.usage.stale", { detail: updatedLabel }) : undefined}
    data-testid="persistent-session-weekly-usage"
  >
    {displayGauges.length === 0 ? placeholderRows : null}
    {displayGauges.length ? displayGauges.map(gauge => {
      const bestWeekly = claudePool?.best_weekly_remaining_percent;
      const remaining = gauge.id === "claude" && fullyBlocked
        ? 0
        : gauge.id === "claude" && showPoolCount && bestWeekly !== null && bestWeekly !== undefined
          ? bestWeekly
          : gauge.remainingPercent;
      const resetAt = gauge.id === "claude" && showPoolCount
        ? epochSeconds(claudePool?.best_weekly_resets_at ?? null) ?? gauge.resetAt
        : gauge.resetAt;
      const used = weeklyUsedPercent(remaining);
      const percent = used === null ? "—" : percentFormat.format(used / 100);
      const warning = used !== null && used >= 80;
      const countdown = remaining === null ? null : formatUsageCountdown(resetAt, evaluatedAtMs, locale);
      const fullCountdown = gauge.id === "claude" && fullyBlocked && releaseLabel
        ? t("persistent.usage.recovery", { time: releaseLabel })
        : countdown?.full;
      const compactCountdown = gauge.id === "claude" && fullyBlocked && releaseLabel
        ? releaseLabel
        : countdown?.compact;
      const countState = claudePool?.available_count === 0 ? "danger" : claudePool && claudePool.available_count < claudePool.total_count ? "warn" : undefined;
      return <div className="persistent-session-weekly-usage-row" key={gauge.id}>
        <div className="persistent-session-weekly-usage-labels">
          <span className="persistent-session-weekly-usage-provider">{gauge.label}{gauge.id === "claude" && showPoolCount ? <span className="persistent-session-weekly-usage-pool-count" data-warn={countState === "warn" || undefined} data-danger={countState === "danger" || undefined}>{numberFormat.format(claudePool.available_count)}/{numberFormat.format(claudePool.total_count)}</span> : null}</span>
          {compactCountdown ? <span className="persistent-session-weekly-usage-countdown" aria-label={fullCountdown ? (fullyBlocked ? fullCountdown : t("persistent.usage.resetIn", { time: fullCountdown })) : undefined}>{compactCountdown}</span> : null}
          <strong className={warning ? "is-warning" : undefined}>{percent}</strong>
        </div>
        <div
          className={`persistent-session-weekly-usage-track${warning ? " is-warning" : ""}`}
          role={remaining === null ? undefined : "progressbar"}
          aria-hidden={remaining === null || undefined}
          aria-label={remaining === null ? undefined : t("persistent.usage.provider", { provider: gauge.label })}
          aria-valuemin={remaining === null ? undefined : 0}
          aria-valuemax={remaining === null ? undefined : 100}
          aria-valuenow={used ?? undefined}
          aria-valuetext={remaining === null ? undefined : percent}
        >
          {used === null ? null : <i style={{ width: `${used}%` }} />}
        </div>
      </div>;
    }) : message || loadState === "connectionError" ? <div className="persistent-session-weekly-usage-row is-status">
      <div className="persistent-session-weekly-usage-labels">
        <span className="persistent-session-weekly-usage-status" role="status">{message}</span>
        {loadState === "connectionError" ? <DashboardIconCap appearance="bare" size="small" className="persistent-session-weekly-usage-retry" label={t("persistent.usage.retry")} disabled={loading} onClick={onRetry}>
          <RefreshCw className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
        </DashboardIconCap> : null}
      </div>
      <div className="persistent-session-weekly-usage-track" aria-hidden="true" />
    </div> : null}
    {node ? <button type="button" className="persistent-session-weekly-usage-node" aria-label={t("persistent.usage.switchNode", { node: node.nodeId })} onClick={onNextNode}>
      <span>{node.nodeId}</span><ChevronRight className="persistent-session-weekly-usage-chevron size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
    </button> : <div className="persistent-session-weekly-usage-node is-placeholder" aria-hidden="true" />}
  </div>;
}
