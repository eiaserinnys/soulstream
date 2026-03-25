/**
 * ResponseNode - Claude의 최종 응답 노드
 *
 * Thinking 노드보다 약간 더 크고 눈에 띄는 디자인입니다.
 * 실행 흐름의 종단점으로 상단 target handle만 갖습니다.
 */

import { memo } from 'react';
import { type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../../lib/layout-engine';
import { cn } from '../../lib/cn';
import { nodeBase, nodeHeader, truncate2, NODE_COLORS } from './node-styles';
import { NodeHandles } from './NodeHandles';

type ResponseNodeType = Node<GraphNodeData, 'response'>;

export const ResponseNode = memo(function ResponseNode({ data, selected }: NodeProps<ResponseNodeType>) {
  const isStreaming = data.streaming;

  return (
    <div
      data-testid="response-node"
      className={cn(
        nodeBase,
        "bg-card border relative",
        selected
          ? "border-node-response shadow-[0_2px_12px_rgba(0,0,0,0.5)]"
          : "border-node-response/25 shadow-[0_2px_12px_rgba(0,0,0,0.5)]",
      )}
    >
      {/* Left accent bar (wider for emphasis) */}
      <div className="w-[5px] shrink-0 bg-node-response rounded-l-lg" />

      {/* Content area */}
      <div className="flex-1 px-3.5 py-3 min-w-0">
        {/* Header row */}
        <div className={cn(nodeHeader, "mb-2")}>
          <span className="text-sm shrink-0">{'\u{1F4AC}'}</span>
          <span className="text-[13px] text-node-response uppercase tracking-[0.05em] font-bold">
            Response
          </span>
          {isStreaming && (
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-node-response shrink-0 animate-[pulse_2s_infinite]" />
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
      <NodeHandles color={NODE_COLORS.response} />
    </div>
  );
});
