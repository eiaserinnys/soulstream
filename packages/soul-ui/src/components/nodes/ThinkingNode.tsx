/**
 * ThinkingNode - Claude의 중간 텍스트 출력 (사고/추론) 노드
 *
 * streaming 상태일 때 shimmer 애니메이션 오버레이를 표시합니다.
 * keyframes (node-shimmer, pulse)는 globals.css에 정의되어 있습니다.
 */

import { memo, useCallback } from 'react';
import { type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../../lib/layout-engine';
import { cn } from '../../lib/cn';
import { nodeBase, nodeContent, nodeHeader, nodeLabel, truncate2, collapseButton, NODE_COLORS } from './node-styles';
import { NodeHandles } from './NodeHandles';
import { useDashboardStore } from '../../stores/dashboard-store';

type ThinkingNodeType = Node<GraphNodeData, 'thinking'>;

export const ThinkingNode = memo(function ThinkingNode({ data, selected }: NodeProps<ThinkingNodeType>) {
  const isStreaming = data.streaming;
  const isPlanMode = data.isPlanMode;
  const accentColor = isPlanMode ? NODE_COLORS.plan : NODE_COLORS.thinking;
  const toggleNodeCollapse = useDashboardStore((s) => s.toggleNodeCollapse);

  const handleCollapseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (data.cardId) {
      toggleNodeCollapse(data.cardId);
    }
  }, [data.cardId, toggleNodeCollapse]);

  return (
    <div
      data-testid="thinking-node"
      className={cn(
        nodeBase,
        "border relative",
        isPlanMode ? "bg-node-plan/6" : "bg-card",
        selected
          ? isPlanMode ? "border-node-plan" : "border-node-thinking"
          : isPlanMode
            ? "border-node-plan/25"
            : "border-border",
      )}
    >
      {/* Left accent bar */}
      <div
        className="w-1 shrink-0 rounded-l-lg"
        style={{ background: accentColor }}
      />

      {/* Content area */}
      <div className={nodeContent}>
        {/* Header row */}
        <div className={nodeHeader}>
          <span className="text-sm shrink-0">{data.nodeType === "text" ? '\u{1F642}' : '\u{1F4AD}'}</span>
          <span className={cn(
            nodeLabel,
            isPlanMode ? "text-node-plan" : "text-muted-foreground",
          )}>
            {data.nodeType === "text" ? "Assistant" : "Thinking"}
          </span>
          {isPlanMode && (
            <span className="text-[9px] text-node-plan font-medium px-[5px] py-px rounded-[3px] bg-node-plan/12">
              PLAN
            </span>
          )}
          {data.hasChildren && (
            <button
              type="button"
              className={cn(collapseButton, "ml-auto")}
              onClick={handleCollapseClick}
              aria-label={data.collapsed ? "Expand node" : "Collapse node"}
            >
              {data.collapsed ? `▶ (${data.childCount})` : "▼"}
            </button>
          )}
          {isStreaming && !data.hasChildren && (
            <span
              className="ml-auto w-1.5 h-1.5 rounded-full shrink-0 animate-[pulse_2s_infinite]"
              style={{ background: accentColor }}
            />
          )}
        </div>

        {/* Truncated content */}
        <div className={cn("text-[12px] text-muted-foreground leading-normal italic", truncate2)}>
          {data.content || data.label || '(thinking...)'}
        </div>
      </div>

      {/* Shimmer overlay when streaming */}
      {isStreaming && (
        <div className={cn(
          "absolute inset-0 rounded-lg pointer-events-none",
          isPlanMode ? "shimmer-cyan" : "shimmer-purple",
        )} />
      )}

      {/* Handles */}
      <NodeHandles color={accentColor} />
    </div>
  );
});
