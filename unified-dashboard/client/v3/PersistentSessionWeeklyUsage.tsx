import { DashboardIconCap, formatUsageResetCountdown, formatUsageUpdatedLabel, formatWeeklyRemainingPercent } from "@seosoyoung/soul-ui";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { UsageSummaryGauge } from "@seosoyoung/soul-ui";
import type { UseUsageSummaryResult } from "../hooks/useUsageSummary";

type Props = Pick<UseUsageSummaryResult, "node" | "gauges" | "loading" | "loadState" | "evaluatedAtMs"> & {
  onRetry: () => void;
  onNextNode: () => void;
};

function emptyMessage({ loading, loadState, node, gauges }: Pick<Props, "loading" | "loadState" | "node" | "gauges">): string | null {
  if (gauges.length) return null;
  if (loading) return "불러오는 중";
  if (loadState === "connectionError") return "조회 실패";
  if (node) return "주간 한도 없음";
  return "수집 대기";
}

type DisplayGauge = Omit<UsageSummaryGauge, "remainingPercent"> & { remainingPercent: number | null };

function localReleaseTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)} 해제`;
}

function epochSeconds(value: string | null): number | null {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Math.trunc(milliseconds / 1000) : null;
}

export function PersistentSessionWeeklyUsage({ node, gauges, loading, loadState, evaluatedAtMs, onRetry, onNextNode }: Props) {
  const message = emptyMessage({ node, gauges, loading, loadState });
  const claudeProvider = node?.providers.claude;
  const claudePool = claudeProvider?.mode === "pool" ? claudeProvider.pool : null;
  const showPoolCount = !!claudePool && claudePool.total_count >= 2;
  const fullyBlocked = showPoolCount && claudePool.available_count === 0;
  const releaseLabel = fullyBlocked ? localReleaseTime(claudePool?.earliest_available_at ?? null) : null;
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
  const updatedLabel = stale && node ? formatUsageUpdatedLabel(node.fetchedAt, true) : null;
  const placeholders = displayGauges.length === 0 ? 2 : 0;
  const placeholderRows = Array.from({ length: placeholders }, (_, index) => <div className="persistent-session-weekly-usage-row is-placeholder" aria-hidden="true" key={`placeholder-${index}`}>
    <div className="persistent-session-weekly-usage-labels persistent-session-weekly-usage-placeholder-labels" />
    <div className="persistent-session-weekly-usage-track" />
  </div>);

  return <div
    className="persistent-session-weekly-usage"
    role="group"
    aria-label="주간 남은 사용량"
    title={stale && updatedLabel ? `갱신 지연, ${updatedLabel}` : undefined}
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
      const percent = remaining === null ? "—" : formatWeeklyRemainingPercent(remaining);
      const warning = remaining !== null && remaining < 20;
      const fullCountdown = gauge.id === "claude" && fullyBlocked && releaseLabel
        ? `회복 예정 ${releaseLabel}`
        : remaining === null ? null : formatUsageResetCountdown(resetAt, evaluatedAtMs, false);
      const compactCountdown = gauge.id === "claude" && fullyBlocked && releaseLabel
        ? releaseLabel
        : remaining === null ? null : formatUsageResetCountdown(resetAt, evaluatedAtMs, true);
      const countState = claudePool?.available_count === 0 ? "danger" : claudePool && claudePool.available_count < claudePool.total_count ? "warn" : undefined;
      return <div className="persistent-session-weekly-usage-row" key={gauge.id}>
        <div className="persistent-session-weekly-usage-labels">
          <span className="persistent-session-weekly-usage-provider">{gauge.label}{gauge.id === "claude" && showPoolCount ? <span className="persistent-session-weekly-usage-pool-count" data-warn={countState === "warn" || undefined} data-danger={countState === "danger" || undefined}>{claudePool?.available_count}/{claudePool?.total_count}</span> : null}</span>
          {compactCountdown ? <span className="persistent-session-weekly-usage-countdown" aria-label={fullCountdown ? (fullyBlocked ? fullCountdown : `초기화까지 ${fullCountdown}`) : undefined}>{compactCountdown}</span> : null}
          <strong className={warning ? "is-warning" : undefined}>{percent}</strong>
        </div>
        <div
          className={`persistent-session-weekly-usage-track${warning ? " is-warning" : ""}`}
          role={remaining === null ? undefined : "progressbar"}
          aria-hidden={remaining === null || undefined}
          aria-label={remaining === null ? undefined : `${gauge.label} 주간 잔량`}
          aria-valuemin={remaining === null ? undefined : 0}
          aria-valuemax={remaining === null ? undefined : 100}
          aria-valuenow={remaining ?? undefined}
          aria-valuetext={remaining === null ? undefined : percent}
        >
          {remaining === null ? null : <i style={{ width: `${remaining}%` }} />}
        </div>
      </div>;
    }) : <div className="persistent-session-weekly-usage-row is-status">
      <div className="persistent-session-weekly-usage-labels">
        <span className="persistent-session-weekly-usage-status" role="status">{message}</span>
        {loadState === "connectionError" ? <DashboardIconCap appearance="bare" size="small" className="persistent-session-weekly-usage-retry" label="주간 사용량 다시 시도" disabled={loading} onClick={onRetry}>
          <RefreshCw className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
        </DashboardIconCap> : null}
      </div>
      <div className="persistent-session-weekly-usage-track" aria-hidden="true" />
    </div>}
    {node ? <button type="button" className="persistent-session-weekly-usage-node" aria-label={`노드 바꾸기, 현재 ${node.nodeId}`} onClick={onNextNode}>
      <span>{node.nodeId}</span><ChevronRight className="persistent-session-weekly-usage-chevron size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
    </button> : <div className="persistent-session-weekly-usage-node is-placeholder" aria-hidden="true" />}
  </div>;
}
