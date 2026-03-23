/**
 * TopBar — 상단 바. 타이틀 + 연결 상태 표시.
 */

import { Badge, cn } from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";

const CONNECTION_CONFIG = {
  connecting: { label: "Connecting...", variant: "warning" as const, dotClass: "bg-accent-amber" },
  connected: { label: "Live", variant: "success" as const, dotClass: "bg-success" },
  error: { label: "Reconnecting...", variant: "error" as const, dotClass: "bg-accent-red" },
};

function ConnectionBadge({ status }: { status: "connecting" | "connected" | "error" }) {
  const config = CONNECTION_CONFIG[status];
  const shouldPulse = status === "connected" || status === "connecting";

  return (
    <Badge variant={config.variant} size="sm">
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          config.dotClass,
          shouldPulse && "animate-[pulse_2s_infinite]",
        )}
      />
      {config.label}
    </Badge>
  );
}

export function TopBar() {
  const connectionStatus = useOrchestratorStore((s) => s.connectionStatus);

  return (
    <div className="flex h-10 items-center justify-between border-b border-border px-4 bg-popover shrink-0">
      <span className="text-sm font-semibold text-muted-foreground tracking-tight">
        Soulstream Orchestrator
      </span>
      <div className="flex items-center gap-2">
        <ConnectionBadge status={connectionStatus} />
      </div>
    </div>
  );
}
