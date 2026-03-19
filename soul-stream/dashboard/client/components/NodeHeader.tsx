/**
 * NodeHeader — 노드 컬럼 상단. 노드 이름, 호스트, 상태, 세션 수 표시.
 */

import type { OrchestratorNode } from "../store/types";

// 노드 식별자에서 첫 글자 추출 (예: "soul-alpha" → "A")
function nodeInitial(nodeId: string): string {
  const parts = nodeId.split("-");
  const last = parts[parts.length - 1];
  return last[0].toUpperCase();
}

// 노드별 색상 (순환)
const NODE_COLORS = [
  { css: "var(--node-user)", raw: "#7ba3e6" },
  { css: "var(--node-response)", raw: "#4db894" },
  { css: "var(--node-tool)", raw: "#d9a83a" },
  { css: "var(--node-thinking)", raw: "#a18ae0" },
  { css: "var(--node-plan)", raw: "#3db5c9" },
];

export function nodeColor(index: number) {
  return NODE_COLORS[index % NODE_COLORS.length];
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
      className={`px-3.5 py-3 border-b border-border cursor-pointer transition-colors shrink-0 ${
        isSelected ? "bg-accent-blue/[0.06]" : "hover:bg-muted"
      }`}
      onClick={onClick}
    >
      {/* Top row: icon + name + status dot */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-semibold font-mono shrink-0"
            style={{
              background: `${color.raw}18`,
              color: color.css,
              border: `1px solid ${color.raw}30`,
            }}
          >
            {nodeInitial(node.nodeId)}
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">
              {node.nodeId}
            </div>
            <div className="text-[11px] font-mono text-muted-foreground/50 mt-px">
              {node.host}:{node.port}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div
            className={`w-[7px] h-[7px] rounded-full shrink-0 ${
              isHealthy
                ? "bg-success shadow-[0_0_6px_rgba(16,185,129,0.3)]"
                : "bg-muted-foreground/30"
            }`}
          />
        </div>
      </div>

      {/* Stats row */}
      <div className="flex gap-2 mt-2">
        <div className="text-[11px] font-mono text-muted-foreground/50 flex items-center gap-1">
          Sessions{" "}
          <span className="text-muted-foreground font-medium">
            {sessionCount}
          </span>
        </div>
      </div>
    </div>
  );
}
