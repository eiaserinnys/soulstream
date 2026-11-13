import { Badge, cn } from "@seosoyoung/soul-ui";
import type { CogitoNodeHealth, CogitoNodeStatus } from "../lib/cogito-health";

type BadgeVariant = "outline" | "warning" | "success" | "error";
type PanelStatus = CogitoNodeStatus | "loading" | "unavailable";

const STATUS_CONFIG: Record<
  PanelStatus,
  { label: string; variant: BadgeVariant; dotClass: string }
> = {
  ok: { label: "OK", variant: "success", dotClass: "bg-success" },
  timeout: { label: "Timeout", variant: "warning", dotClass: "bg-accent-amber" },
  unavailable: { label: "Unavailable", variant: "warning", dotClass: "bg-accent-amber" },
  error: { label: "Error", variant: "error", dotClass: "bg-accent-red" },
  loading: { label: "Checking", variant: "outline", dotClass: "bg-muted-foreground/50" },
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
  const metaClass = embedded
    ? "c724-meta-inline truncate"
    : "text-[11px] text-muted-foreground truncate";

  return (
    <div
      className={cn(embedded ? "c724-account-row mt-2" : "px-3 py-1.5 border-t border-border/60 space-y-1")}
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
        {node.checkedAt ? ` / ${formatCheckedAt(node.checkedAt)}` : ""}
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
    <div className="c724-account-row mt-2" data-testid="cogito-node-health" data-node-state={state.kind}>
      <div className="c724-account-top">
        <div className="c724-account-identity">
          <StatusDot status={status} />
          <span className="c724-account-email">Cogito</span>
        </div>
        <StatusBadge status={status} />
      </div>
      <div className="c724-meta-inline truncate">
        {state.kind === "loading" ? "Checking..." : state.message}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: PanelStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <Badge variant={config.variant} size="sm">
      {config.label}
    </Badge>
  );
}

function StatusDot({ status }: { status: PanelStatus }) {
  const config = STATUS_CONFIG[status];
  return <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", config.dotClass)} />;
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

function formatCheckedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
