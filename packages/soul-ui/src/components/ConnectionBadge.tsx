/**
 * ConnectionBadge - SSE 연결 상태를 표시하는 배지
 *
 * 4가지 상태: disconnected, connecting, connected, error
 * connected/connecting 시 pulse 애니메이션을 표시합니다.
 */

import { Badge } from "../components/ui/badge";
import { cn } from "../lib/cn";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

const CONNECTION_CONFIG: Record<
  ConnectionStatus,
  { label: string; variant: "outline" | "warning" | "success" | "error"; dotClass: string }
> = {
  disconnected: { label: "Idle", variant: "outline", dotClass: "bg-muted-foreground" },
  connecting: { label: "Connecting...", variant: "warning", dotClass: "bg-accent-amber" },
  connected: { label: "Live", variant: "success", dotClass: "bg-success" },
  error: { label: "Reconnecting...", variant: "error", dotClass: "bg-accent-red" },
};

export interface ConnectionBadgeProps {
  status: ConnectionStatus;
}

export function ConnectionBadge({ status }: ConnectionBadgeProps) {
  const config = CONNECTION_CONFIG[status];
  const shouldPulse = status === "connected" || status === "connecting";

  return (
    <Badge data-testid="connection-badge" variant={config.variant} size="sm">
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
