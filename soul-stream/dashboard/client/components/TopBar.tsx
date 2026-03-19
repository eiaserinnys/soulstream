/**
 * TopBar — 상단 바. 타이틀 + 연결 상태 표시.
 */

import { useOrchestratorStore } from "../store/orchestrator-store";

export function TopBar() {
  const connectionStatus = useOrchestratorStore((s) => s.connectionStatus);

  const isConnected = connectionStatus === "connected";
  const label = isConnected ? "Connected" : connectionStatus === "connecting" ? "Connecting..." : "Disconnected";

  return (
    <div className="flex h-10 items-center justify-between border-b border-border px-4 bg-popover shrink-0">
      <span className="text-sm font-semibold text-muted-foreground tracking-tight">
        Soulstream Orchestrator
      </span>
      <div className="flex items-center gap-2">
        <div
          className={`flex items-center gap-1.5 text-[11px] font-mono px-2 py-0.5 rounded-md border ${
            isConnected
              ? "text-success border-success/20 bg-success/[0.06]"
              : "text-muted-foreground border-border bg-muted"
          }`}
        >
          <div className="relative">
            <div
              className={`w-1.5 h-1.5 rounded-full ${
                isConnected ? "bg-success" : "bg-muted-foreground"
              }`}
            />
            {isConnected && (
              <div className="absolute inset-0 rounded-full bg-success animate-ping opacity-50" />
            )}
          </div>
          <span>{label}</span>
        </div>
      </div>
    </div>
  );
}
