/**
 * InputRequestNode - 사용자 입력 요청 노드
 *
 * AskUserQuestion 이벤트를 핑크색 노드로 표시합니다.
 * responded 상태에 따라 이모지와 border 색상이 변경됩니다.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../lib/layout-engine';
import { cn } from '../lib/cn';
import { nodeBase, nodeBgDefault, nodeContent, nodeHeader, nodeLabel, truncate2, handleStyle, NODE_COLORS } from './node-styles';

type InputRequestNodeData = Node<GraphNodeData, 'input_request'>;

export const InputRequestNode = memo(function InputRequestNode({ data, selected }: NodeProps<InputRequestNodeData>) {
  const responded = data.responded ?? false;
  return (
    <div
      data-testid="input-request-node"
      className={cn(
        nodeBase, nodeBgDefault,
        "border",
        selected ? "border-node-input-request" : "border-border",
        !responded && "animate-pulse-border-pink",
      )}
    >
      {/* Left accent bar */}
      <div className="w-1 shrink-0 bg-node-input-request rounded-l-lg" />

      {/* Content area */}
      <div className={nodeContent}>
        {/* Header row */}
        <div className={nodeHeader}>
          <span className="text-sm shrink-0">{responded ? '\u2705' : '\u2753'}</span>
          <span className={cn(nodeLabel, "text-muted-foreground")}>
            {responded ? 'Answered' : 'Input Request'}
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
