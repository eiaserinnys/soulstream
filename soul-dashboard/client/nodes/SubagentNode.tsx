/**
 * SubagentNode - 서브에이전트 노드
 *
 * Task 도구를 통해 생성된 서브에이전트를 시각화합니다.
 * 보라색 배경으로 구분되며, 접기/펼치기 버튼을 제공합니다.
 */

import { memo, useCallback } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { GraphNodeData } from "../lib/layout-engine";
import { cn } from "../lib/cn";
import { nodeBase, nodeContent, nodeHeader, nodeLabel, truncate2, handleStyle, collapseButton } from "./node-styles";
import { useDashboardStore } from "../stores/dashboard-store";

type SubagentNodeType = Node<GraphNodeData, "subagent">;

const ACCENT = "#a855f7"; // purple-500

export const SubagentNode = memo(function SubagentNode({ data, selected }: NodeProps<SubagentNodeType>) {
  const isStreaming = data.streaming;
  const toggleNodeCollapse = useDashboardStore((s) => s.toggleNodeCollapse);

  const handleCollapseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (data.cardId) {
      toggleNodeCollapse(data.cardId);
    }
  }, [data.cardId, toggleNodeCollapse]);

  return (
    <div
      data-testid="subagent-node"
      className={cn(
        nodeBase,
        "border relative",
        "bg-purple-950/50",
        selected ? "border-purple-400" : "border-purple-500/50",
        isStreaming && "border-purple-400",
      )}
    >
      {/* Left accent bar */}
      <div
        className="w-1 shrink-0 rounded-l-lg"
        style={{ background: ACCENT }}
      />

      {/* Content area */}
      <div className={nodeContent}>
        {/* Header row */}
        <div className={nodeHeader}>
          <span className="text-sm shrink-0">{"\u{1F916}"}</span>
          <span className={cn(nodeLabel, "text-purple-300")}>
            {data.agentType || "Agent"}
          </span>
          {data.hasChildren && (
            <button
              type="button"
              className={cn(collapseButton, "ml-auto text-purple-200 hover:text-purple-100")}
              onClick={handleCollapseClick}
              aria-label={data.collapsed ? "Expand node" : "Collapse node"}
            >
              {data.collapsed ? `▶ (${data.childCount})` : "▼"}
            </button>
          )}
          {isStreaming && (
            <span
              className="ml-1 w-1.5 h-1.5 rounded-full shrink-0 animate-[pulse_2s_infinite]"
              style={{ background: ACCENT }}
            />
          )}
        </div>

        {/* Agent info */}
        <div className={cn("text-xs text-purple-200 leading-normal", truncate2)}>
          {data.label || data.agentId || "Subagent"}
        </div>
      </div>

      {/* Shimmer overlay when streaming */}
      {isStreaming && (
        <div className="absolute inset-0 rounded-lg pointer-events-none shimmer-purple" />
      )}

      {/* Handles */}
      <Handle type="target" position={Position.Left} id="left" style={handleStyle(ACCENT)} />
      <Handle type="source" position={Position.Right} id="right" style={handleStyle(ACCENT)} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={handleStyle(ACCENT)} />
    </div>
  );
});
