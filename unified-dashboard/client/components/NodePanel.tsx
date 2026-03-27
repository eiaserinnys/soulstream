/**
 * NodePanel - 좌측 하단 노드 목록 패널 (unified-dashboard)
 *
 * orchestrator-dashboard의 NodePanel.tsx에서 포팅.
 * orchestrator 모드(features.nodePanel = true)에서만 사용된다.
 */

import { useMemo } from "react";
import { cn, nodeIdToHue, useTheme } from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";

export function NodePanel() {
  const nodes = useOrchestratorStore((s) => s.nodes);
  const { theme } = useTheme();

  const nodeList = useMemo(() => Array.from(nodes.values()), [nodes]);

  if (nodeList.length === 0) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-3 py-1.5 shrink-0 border-b border-border">
          <span className="text-sm font-semibold">Nodes</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground/40 text-xs">
          No nodes
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-3 py-1.5 shrink-0 border-b border-border">
        <span className="text-sm font-semibold">Nodes</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {nodeList.map((node) => {
          const hue = nodeIdToHue(node.nodeId);
          const isDead = node.status === "disconnected";
          const isDark = theme === "dark";

          return (
            <div
              key={node.nodeId}
              className={cn("border-b border-border", isDead && "opacity-60")}
            >
              {/* Node header row */}
              <div className="flex items-center gap-2 px-3 py-2 select-none">
                <div
                  className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold font-mono shrink-0"
                  style={{
                    background: `hsl(${hue}, 12%, ${isDark ? "28%" : "88%"})`,
                    color: `hsl(${hue}, ${isDark ? "18%, 72%" : "30%, 35%"})`,
                    border: `1px solid hsl(${hue}, 12%, ${isDark ? "35%" : "75%"})`,
                  }}
                >
                  {node.nodeId[0]?.toUpperCase()}
                </div>
                <span className="text-sm font-medium text-foreground truncate flex-1">
                  {node.nodeId}
                </span>
                <div
                  className={cn(
                    "w-[7px] h-[7px] rounded-full shrink-0",
                    isDead
                      ? "bg-muted-foreground/30"
                      : "bg-success shadow-[0_0_6px_rgba(16,185,129,0.3)]",
                  )}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
