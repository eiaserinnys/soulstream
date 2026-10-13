import { DashboardIconCap, formatUsageResetCountdown, formatUsageUpdatedLabel, formatWeeklyRemainingPercent } from "@seosoyoung/soul-ui";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { UseUsageSummaryResult } from "../hooks/useUsageSummary";

type Props = Pick<UseUsageSummaryResult, "node" | "gauges" | "maxGaugeCount" | "loading" | "loadState" | "evaluatedAtMs"> & {
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

export function PersistentSessionWeeklyUsage({ node, gauges, maxGaugeCount, loading, loadState, evaluatedAtMs, onRetry, onNextNode }: Props) {
  const message = emptyMessage({ node, gauges, loading, loadState });
  const stale = loadState === "connectionError" && gauges.length > 0;
  const updatedLabel = stale && node ? formatUsageUpdatedLabel(node.fetchedAt, true) : null;
  const slotCount = Math.max(3, maxGaugeCount, gauges.length);
  const placeholders = Math.max(0, slotCount - (gauges.length || 1));

  return <div
    className="persistent-session-weekly-usage"
    role="group"
    aria-label="주간 남은 사용량"
    title={stale && updatedLabel ? `갱신 지연 · ${updatedLabel}` : undefined}
    data-testid="persistent-session-weekly-usage"
  >
    {Array.from({ length: placeholders }, (_, index) => <div className="persistent-session-weekly-usage-row is-placeholder" aria-hidden="true" key={`placeholder-${index}`}>
      <div className="persistent-session-weekly-usage-labels persistent-session-weekly-usage-placeholder-labels" />
      <div className="persistent-session-weekly-usage-track" />
    </div>)}
    {gauges.length ? gauges.map(gauge => {
      const percent = formatWeeklyRemainingPercent(gauge.remainingPercent);
      const warning = gauge.remainingPercent < 20;
      const fullCountdown = formatUsageResetCountdown(gauge.resetAt, evaluatedAtMs, false);
      const compactCountdown = formatUsageResetCountdown(gauge.resetAt, evaluatedAtMs, true);
      return <div className="persistent-session-weekly-usage-row" key={gauge.id}>
        <div className="persistent-session-weekly-usage-labels">
          <span className="persistent-session-weekly-usage-provider">{gauge.label}</span>
          {compactCountdown ? <span className="persistent-session-weekly-usage-countdown" aria-label={fullCountdown ? `초기화까지 ${fullCountdown}` : undefined}>{compactCountdown}</span> : null}
          <strong className={warning ? "is-warning" : undefined}>{percent}</strong>
        </div>
        <div
          className={`persistent-session-weekly-usage-track${warning ? " is-warning" : ""}`}
          role="progressbar"
          aria-label={`${gauge.label} 주간 잔량`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={gauge.remainingPercent}
          aria-valuetext={percent}
        >
          <i style={{ width: `${gauge.remainingPercent}%` }} />
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
