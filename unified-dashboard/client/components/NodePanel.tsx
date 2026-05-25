/**
 * NodePanel - 좌측 하단 노드 목록 패널 (unified-dashboard)
 *
 * orchestrator-dashboard의 NodePanel.tsx에서 포팅.
 * orchestrator 모드(features.nodePanel = true)에서만 사용된다.
 * 노드 헤더 클릭 시 NodeClaudeAuthPanel이 확장된다.
 */

import { useMemo, useState } from "react";
import { cn, nodeIdToHue, useTheme, ScrollArea } from "@seosoyoung/soul-ui";
import { useOrchestratorStore } from "../store/orchestrator-store";
import { CogitoHealthPanel } from "./CogitoHealthPanel";
import { NodeClaudeAuthPanel } from "./NodeClaudeAuthPanel";

export function NodePanel() {
  const nodes = useOrchestratorStore((s) => s.nodes);
  const [theme] = useTheme();
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);

  const nodeList = useMemo(() => Array.from(nodes.values()), [nodes]);

  return (
    <div className="h-full flex flex-col overflow-hidden min-h-0">
      <div className="px-3 py-1.5 shrink-0 border-b border-border">
        <span className="text-sm font-semibold">Nodes</span>
      </div>
      <CogitoHealthPanel />
      {nodeList.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground/40 text-sm">
          No nodes
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          {nodeList.map((node) => {
            const hue = nodeIdToHue(node.nodeId);
            const isDead = node.status === "disconnected";
            const isDark = theme === "dark";
            const isExpanded = expandedNodeId === node.nodeId;

            return (
              <div
                key={node.nodeId}
                className={cn("border-b border-border", isDead && "opacity-60")}
              >
                {/* Node header row — 클릭 시 Claude Auth 패널 토글 */}
                <div
                  className="flex items-center gap-2 px-3 py-2 select-none cursor-pointer hover:bg-muted/30"
                  onClick={() =>
                    setExpandedNodeId(isExpanded ? null : node.nodeId)
                  }
                >
                  <div
                    className="w-5 h-5 rounded flex items-center justify-center text-xs font-bold font-mono shrink-0"
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
                  <span className="text-xs text-muted-foreground">
                    {isExpanded ? "▲" : "▼"}
                  </span>
                </div>
                {/* 확장 패널 — Claude Code 크레덴셜 */}
                {isExpanded && <NodeClaudeAuthPanel nodeId={node.nodeId} />}
              </div>
            );
          })}
        </ScrollArea>
      )}
    </div>
  );
}
