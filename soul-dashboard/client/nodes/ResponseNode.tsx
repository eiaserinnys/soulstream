/**
 * ResponseNode - Claude의 최종 응답 노드
 *
 * Thinking 노드보다 약간 더 크고 눈에 띄는 디자인입니다.
 * 실행 흐름의 종단점으로 상단 target handle만 갖습니다.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../lib/layout-engine';
import { cn } from '../lib/cn';
import { nodeBase, nodeHeader, truncate2, handleStyle } from './node-styles';

type ResponseNodeType = Node<GraphNodeData, 'response'>;

const ACCENT = '#10b981';

export const ResponseNode = memo(function ResponseNode({ data, selected }: NodeProps<ResponseNodeType>) {
  const isStreaming = data.streaming;

  return (
    <div
      data-testid="response-node"
      className={cn(
        nodeBase,
        "bg-card border relative",
        selected
          ? "border-accent-green shadow-[0_2px_12px_rgba(0,0,0,0.5),0_0_0_1px_rgba(16,185,129,0.27)]"
          : "border-accent-green/25 shadow-[0_2px_12px_rgba(0,0,0,0.5)]",
      )}
    >
      {/* Left accent bar (wider for emphasis) */}
      <div className="w-[5px] shrink-0 bg-accent-green rounded-l-lg" />

      {/* Content area */}
      <div className="flex-1 px-3.5 py-3 min-w-0">
        {/* Header row */}
        <div className={cn(nodeHeader, "mb-2")}>
          <span className="text-sm shrink-0">{'\u{1F4AC}'}</span>
          <span className="text-[10px] text-accent-green uppercase tracking-[0.05em] font-bold">
            Response
          </span>
          {isStreaming && (
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-accent-green shrink-0 animate-[pulse_2s_infinite]" />
          )}
        </div>

        {/* Truncated content (3 lines for response) */}
        <div className={cn("text-xs text-foreground leading-relaxed", truncate2)}>
          {data.content || data.label || '(empty response)'}
        </div>
      </div>

      {/* Shimmer overlay when streaming */}
      {isStreaming && (
        <div className="absolute inset-0 rounded-lg pointer-events-none shimmer-green" />
      )}

      {/* Handles */}
      <Handle type="target" position={Position.Top} style={handleStyle(ACCENT)} />
      <Handle type="source" position={Position.Bottom} style={handleStyle(ACCENT)} />
    </div>
  );
});
