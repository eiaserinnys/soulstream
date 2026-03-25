/**
 * InputRequestNode - 사용자 입력 요청 노드
 *
 * AskUserQuestion 이벤트를 핑크색 노드로 표시합니다.
 * AskQuestionBanner가 화면 하단 중앙에 실제 UI를 표시하므로,
 * 이 노드는 시각적 마커 역할만 합니다.
 * responded/expired 상태에 따라 이모지와 스타일이 변경됩니다.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../../lib/layout-engine';
import { cn } from '../../lib/cn';
import { nodeBase, nodeBgDefault, nodeContent, nodeHeader, nodeLabel, truncate2, handleStyle, NODE_COLORS } from './node-styles';

type InputRequestNodeData = Node<GraphNodeData, 'input_request'>;

export const InputRequestNode = memo(function InputRequestNode({ data, selected }: NodeProps<InputRequestNodeData>) {
  const responded = data.responded ?? false;
  const expired = data.expired ?? false;

  const statusEmoji = responded ? '\u2705' : expired ? '\u23F1' : '\u2753';
  const statusLabel = responded ? 'Answered' : expired ? 'Timed Out' : 'Input Request';

  return (
    <div
      data-testid="input-request-node"
      className={cn(
        nodeBase, nodeBgDefault,
        "border",
        selected ? "border-node-input-request" : "border-border",
        !responded && !expired && "animate-pulse-border-pink",
      )}
    >
      {/* Left accent bar */}
      <div className="w-1 shrink-0 bg-node-input-request rounded-l-lg" />

      {/* Content area */}
      <div className={nodeContent}>
        {/* Header row */}
        <div className={nodeHeader}>
          <span className="text-sm shrink-0">{statusEmoji}</span>
          <span className={cn(nodeLabel, "text-muted-foreground")}>
            {statusLabel}
          </span>
        </div>

        {/* Truncated question */}
        <div className={cn("text-xs text-foreground leading-normal", truncate2)}>
          {data.content || '(waiting for input...)'}
        </div>
      </div>

      {/* Handles */}
      <Handle type="target" position={Position.Top} style={handleStyle(NODE_COLORS.inputRequest)} />
      <Handle type="source" position={Position.Bottom} style={handleStyle(NODE_COLORS.inputRequest)} />
    </div>
  );
});
