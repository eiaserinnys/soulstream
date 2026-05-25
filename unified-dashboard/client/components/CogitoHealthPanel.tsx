import { RefreshCw } from "lucide-react";
import { Badge, Button, cn } from "@seosoyoung/soul-ui";
import type {
  CogitoAggregateStatus,
  CogitoHealthSummary,
  CogitoNodeHealth,
  CogitoNodeStatus,
} from "../lib/cogito-health";
import { useCogitoHealth } from "../hooks/useCogitoHealth";

type BadgeVariant = "outline" | "warning" | "success" | "error";
type PanelStatus = CogitoAggregateStatus | CogitoNodeStatus | "loading" | "unavailable";

export type CogitoHealthPanelState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; summary: CogitoHealthSummary; refreshing?: boolean };

const STATUS_CONFIG: Record<
  PanelStatus,
  { label: string; variant: BadgeVariant; dotClass: string }
> = {
  ok: { label: "OK", variant: "success", dotClass: "bg-success" },
  partial: { label: "Partial", variant: "warning", dotClass: "bg-accent-amber" },
  empty: { label: "Empty", variant: "outline", dotClass: "bg-muted-foreground/50" },
  timeout: { label: "Timeout", variant: "warning", dotClass: "bg-accent-amber" },
  unavailable: { label: "Unavailable", variant: "warning", dotClass: "bg-accent-amber" },
  error: { label: "Error", variant: "error", dotClass: "bg-accent-red" },
  loading: { label: "Checking", variant: "outline", dotClass: "bg-muted-foreground/50" },
};

export function CogitoHealthPanel() {
  const { summary, loading, refreshing, error, refresh } = useCogitoHealth();
  const state: CogitoHealthPanelState = loading
    ? { kind: "loading" }
    : error
      ? { kind: "error", message: error }
      : summary
        ? { kind: "ready", summary, refreshing }
        : { kind: "error", message: "cogito health unavailable" };

  return <CogitoHealthPanelContent state={state} onRefresh={refresh} />;
}

export function CogitoHealthPanelContent({
  state,
  onRefresh,
}: {
  state: CogitoHealthPanelState;
  onRefresh: () => void;
}) {
  const headerStatus =
    state.kind === "ready"
      ? state.summary.status
      : state.kind === "loading"
        ? "loading"
        : "unavailable";
  const isRefreshing = state.kind === "ready" && state.refreshing;

  return (
    <section
      data-testid="cogito-health-panel"
      className="shrink-0 border-b border-border bg-muted/10 max-h-72 overflow-y-auto"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-sm font-semibold text-foreground">Cogito</span>
        <StatusBadge status={headerStatus} />
        <div className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onRefresh}
          disabled={state.kind === "loading" || isRefreshing}
          title="Refresh cogito health"
          aria-label="Refresh cogito health"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
        </Button>
      </div>

      {state.kind === "loading" ? (
        <div className="px-3 pb-2 text-xs text-muted-foreground">Checking...</div>
      ) : state.kind === "error" ? (
        <div className="px-3 pb-2 text-xs text-muted-foreground truncate">
          {state.message}
        </div>
      ) : state.summary.nodes.length === 0 ? (
        <div className="px-3 pb-2 text-xs text-muted-foreground">No cogito nodes</div>
      ) : (
        <div className="pb-1">
          <div className="px-3 pb-1 text-[11px] text-muted-foreground">
            {formatCheckedAt(state.summary.checkedAt)} / {state.summary.nodeCount} nodes
          </div>
          {state.summary.nodes.map((node) => (
            <CogitoNodeHealthRow key={node.nodeId} node={node} />
          ))}
        </div>
      )}
    </section>
  );
}

function CogitoNodeHealthRow({ node }: { node: CogitoNodeHealth }) {
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

  return (
    <div className="px-3 py-1.5 border-t border-border/60 space-y-1">
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot status={node.status} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {node.nodeId}
        </span>
        <StatusBadge status={node.status} />
      </div>
      <div className="text-[11px] text-muted-foreground truncate">
        {node.serviceStatus}
        {node.checkedAt ? ` / ${formatCheckedAt(node.checkedAt)}` : ""}
      </div>
      {capabilityText && (
        <div className="text-[11px] text-muted-foreground truncate">
          caps {capabilityText}
        </div>
      )}
      {runtimeItems.length > 0 && (
        <div className="text-[11px] text-muted-foreground truncate">
          {runtimeItems.join(" / ")}
        </div>
      )}
      {dependencyText && (
        <div className="text-[11px] text-muted-foreground truncate">
          deps {dependencyText}
        </div>
      )}
      {warning && (
        <div className="text-[11px] text-muted-foreground/80 truncate">
          {warning.code}: {warning.message}
        </div>
      )}
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
