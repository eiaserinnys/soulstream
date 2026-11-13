import { cn } from "@seosoyoung/soul-ui";
import type { CogitoNodeHealth, CogitoNodeStatus } from "../lib/cogito-health";
import { clockLabel } from "./CogitoNodeHealthClock";

type PanelStatus = CogitoNodeStatus | "loading" | "unavailable";

/**
 * 이웃 사용량 행과 같은 규칙을 쓴다.
 *   - 상태 점: `.c724-status-dot`(8px)에 상태 색만 입힌다.
 *   - 배지: `.c724-badge` 알약. 정상은 배지 없이 초록 점만, 로딩은 「Checking...」 줄 하나만.
 */
const STATUS_CONFIG: Record<
  PanelStatus,
  { label: string | null; badgeClass: string | null; dotColor: string }
> = {
  ok: { label: null, badgeClass: null, dotColor: "var(--color-emerald-400)" },
  timeout: { label: "Timeout", badgeClass: "c724-badge c724-badge-warn", dotColor: "var(--color-amber-400)" },
  unavailable: { label: "Unavailable", badgeClass: "c724-badge c724-badge-warn", dotColor: "var(--color-amber-400)" },
  error: { label: "Error", badgeClass: "c724-badge c724-badge-danger", dotColor: "var(--color-red-400)" },
  loading: { label: null, badgeClass: null, dotColor: "var(--v3-text-tertiary)" },
};

export type CogitoNodeHealthNoteState =
  | { kind: "loading" }
  | { kind: "error"; message: string };

/**
 * 노드 하나의 cogito 상태 행.
 * 펼친 노드 안에서는 머리에 노드 이름이 이미 있으므로 embedded 변형이 「Cogito」 라벨을 쓴다.
 */
export function CogitoNodeHealthRow({
  node,
  embedded = false,
}: {
  node: CogitoNodeHealth;
  embedded?: boolean;
}) {
  const runtimeItems = [
    `runtime ${node.runtime.status}`,
    node.runtime.agentCount !== undefined ? `${node.runtime.agentCount} agents` : null,
    node.runtime.activeTaskCount !== undefined ? `${node.runtime.activeTaskCount} tasks` : null,
    node.runtime.uptimeLabel ? `up ${node.runtime.uptimeLabel}` : null,
    node.runtime.memoryLabel,
  ].filter(Boolean);
  const capabilityText = formatCapabilities(node);
  const dependencyText = formatDependencies(node);
  const warning = node.warnings[0];
  const checked = clockLabel(node.checkedAt ?? null);
  // 진단 값 줄은 좁은 폭에서 말줄임 대신 줄바꿈하고, 끌어서 선택할 수 있다(cogito 전용 선택자).
  const metaClass = embedded ? "c724-meta-inline" : "text-[11px] text-muted-foreground truncate";

  return (
    <div
      className={cn(
        "cogito-node-health",
        embedded ? "c724-account-row mt-2" : "px-3 py-1.5 border-t border-border/60 space-y-1",
      )}
      data-testid="cogito-node-health"
      data-node-id={node.nodeId}
    >
      <div className={embedded ? "c724-account-top" : "flex items-center gap-2 min-w-0"}>
        <div className={embedded ? "c724-account-identity" : "contents"}>
          <StatusDot status={node.status} />
          <span
            className={embedded
              ? "c724-account-email"
              : "min-w-0 flex-1 truncate text-xs font-medium text-foreground"}
          >
            {embedded ? "Cogito" : node.nodeId}
          </span>
        </div>
        <StatusBadge status={node.status} />
      </div>
      <div className={metaClass}>
        {node.serviceStatus}
        {checked ? ` / ${checked}` : ""}
      </div>
      {capabilityText && <div className={metaClass}>caps {capabilityText}</div>}
      {runtimeItems.length > 0 && <div className={metaClass}>{runtimeItems.join(" / ")}</div>}
      {dependencyText && <div className={metaClass}>deps {dependencyText}</div>}
      {warning && <div className={metaClass}>{warning.code}: {warning.message}</div>}
    </div>
  );
}

/**
 * cogito를 아직 받는 중이거나 받지 못했을 때, 행이 들어올 자리에 그리는 한 줄.
 * 행과 같은 틀을 써서 응답이 도착해도 자리가 튀지 않는다.
 */
export function CogitoNodeHealthNote({ state }: { state: CogitoNodeHealthNoteState }) {
  const status: PanelStatus = state.kind === "loading" ? "loading" : "unavailable";
  return (
    <div
      className="cogito-node-health c724-account-row mt-2"
      data-testid="cogito-node-health"
      data-node-state={state.kind}
    >
      <div className="c724-account-top">
        <div className="c724-account-identity">
          <StatusDot status={status} />
          <span className="c724-account-email">Cogito</span>
        </div>
        <StatusBadge status={status} />
      </div>
      {state.kind === "loading"
        ? <div className="c724-meta-inline">Checking...</div>
        : <p className="c724-pool-error">{state.message}</p>}
    </div>
  );
}

function StatusBadge({ status }: { status: PanelStatus }) {
  const config = STATUS_CONFIG[status];
  if (!config.badgeClass || !config.label) return null;
  return <span className={config.badgeClass}>{config.label}</span>;
}

function StatusDot({ status }: { status: PanelStatus }) {
  const config = STATUS_CONFIG[status];
  return <span className="c724-status-dot" style={{ backgroundColor: config.dotColor }} />;
}

function formatCapabilities(node: CogitoNodeHealth): string {
  if (node.capabilityCount === 0) return "none";
  const suffix = node.omittedCapabilities > 0 ? ` +${node.omittedCapabilities}` : "";
  return `${node.capabilities.join(", ")}${suffix}`;
}

function formatDependencies(node: CogitoNodeHealth): string {
  if (node.runtime.dependencies.length === 0) return "";
  return node.runtime.dependencies
    .slice(0, 4)
    .map((dep) => `${dep.name}:${dep.status}`)
    .join(", ");
}
