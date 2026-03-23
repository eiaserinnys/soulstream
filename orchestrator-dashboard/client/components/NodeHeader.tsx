/**
 * NodeHeader — 노드 헤더. 이름, 호스트, 상태, 세션 수 표시.
 */

import { NODE_COLORS, cn } from "@seosoyoung/soul-ui";
import type { OrchestratorNode } from "../store/types";

function nodeInitial(nodeId: string): string {
  const parts = nodeId.split("-");
  const last = parts[parts.length - 1];
  return last![0]!.toUpperCase();
}

const NODE_COLOR_KEYS = ['user', 'response', 'tool', 'thinking', 'plan'] as const;

export function nodeColor(index: number): string {
  const key = NODE_COLOR_KEYS[index % NODE_COLOR_KEYS.length];
  return NODE_COLORS[key!];
}

interface NodeHeaderProps {
  node: OrchestratorNode;
  colorIndex: number;
  isSelected: boolean;
  sessionCount: number;
  onClick: () => void;
}

export function NodeHeader({
  node,
  colorIndex,
  isSelected,
  sessionCount,
  onClick,
}: NodeHeaderProps) {
  const color = nodeColor(colorIndex);
  const isHealthy = node.status === "connected";

  return (
    <div
      className={cn(
        "px-3.5 py-3 border-b border-border cursor-pointer transition-colors shrink-0",
        isSelected ? "bg-accent-blue/[0.06]" : "hover:bg-muted",
      )}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-semibold font-mono shrink-0"
            style={{
              background: `color-mix(in srgb, ${color} 10%, transparent)`,
              color: color,
              border: `1px solid color-mix(in srgb, ${color} 19%, transparent)`,
            }}
          >
            {nodeInitial(node.nodeId)}
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">{node.nodeId}</div>
            <div className="text-[11px] font-mono text-muted-foreground/50 mt-px">
              {node.host}:{node.port}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div
            className={cn(
              "w-[7px] h-[7px] rounded-full shrink-0",
              isHealthy
                ? "bg-success shadow-[0_0_6px_rgba(16,185,129,0.3)]"
                : "bg-muted-foreground/30",
            )}
          />
        </div>
      </div>
      <div className="flex gap-2 mt-2">
        <div className="text-[11px] font-mono text-muted-foreground/50 flex items-center gap-1">
          Sessions{" "}
          <span className="text-muted-foreground font-medium">{sessionCount}</span>
        </div>
      </div>
    </div>
  );
}
