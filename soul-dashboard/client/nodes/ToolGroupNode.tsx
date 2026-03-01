/**
 * ToolGroupNode - 동일 도구 그룹 노드
 *
 * 같은 thinking 노드에 연결된 동일 도구 호출을 하나로 묶어 표시합니다.
 * 예: "Read ×12" — 클릭 시 DetailPanel에서 개별 도구 결과를 확인할 수 있습니다.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../lib/layout-engine';
import { cn } from '../lib/cn';
import { nodeBase, nodeBgDefault, nodeContent, nodeHeader, nodeLabel, handleStyle } from './node-styles';

type ToolGroupNodeType = Node<GraphNodeData, 'tool_group'>;

const ACCENT = '#d97706'; // amber-600

export const ToolGroupNode = memo(function ToolGroupNode({ data, selected }: NodeProps<ToolGroupNodeType>) {
  const isStreaming = data.streaming;
  const count = data.groupCount ?? 0;

  return (
    <div
      data-testid="tool-group-node"
      className={cn(
        nodeBase, nodeBgDefault,
        "border",
        selected ? "border-amber-600" : "border-border",
      )}
      style={isStreaming && !selected ? { animation: 'tool-call-pulse 2s infinite' } : undefined}
    >
      {/* Left accent bar */}
      <div className="w-1 shrink-0 bg-amber-600 rounded-l-lg" />

      {/* Content area */}
      <div className={nodeContent}>
        {/* Header row */}
        <div className={nodeHeader}>
          <span className="text-sm shrink-0">📦</span>
          <span className={cn(nodeLabel, "text-muted-foreground")}>
            Tool Group
          </span>
          {/* Count badge */}
          <span className="ml-auto text-[11px] text-amber-600 font-bold px-1.5 py-px rounded bg-amber-600/12">
            ×{count}
          </span>
        </div>

        {/* Tool name */}
        <div
          className="text-[13px] text-foreground font-semibold mb-1 truncate font-mono"
        >
          {data.toolName || 'unknown'}
        </div>

        {/* Summary */}
        <div className="text-[11px] text-muted-foreground truncate">
          {isStreaming ? 'running...' : `${count} calls grouped`}
        </div>
      </div>

      {/* Handles */}
      <Handle type="target" position={Position.Top} id="top" style={handleStyle(ACCENT)} />
      <Handle type="target" position={Position.Left} id="left" style={handleStyle(ACCENT)} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={handleStyle(ACCENT)} />
      <Handle type="source" position={Position.Right} id="right" style={handleStyle(ACCENT)} />
    </div>
  );
});
