/**
 * InterventionNode - 사용자 개입 노드
 *
 * 세션 중간에 사용자가 보낸 추가 메시지/개입을 표시합니다.
 * UserNode와 비슷하지만 주황색 계열로 구분됩니다.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../lib/layout-engine';
import { cn } from '../lib/cn';
import { nodeBase, nodeBgDefault, nodeContent, nodeHeader, nodeLabel, truncate2, handleStyle } from './node-styles';

type InterventionNodeType = Node<GraphNodeData, 'intervention'>;

const ACCENT = '#f97316';

export const InterventionNode = memo(function InterventionNode({ data, selected }: NodeProps<InterventionNodeType>) {
  return (
    <div
      data-testid="intervention-node"
      className={cn(
        nodeBase, nodeBgDefault,
        "border",
        selected ? "border-accent-orange" : "border-border",
      )}
    >
      {/* Left accent bar */}
      <div className="w-1 shrink-0 bg-accent-orange rounded-l-lg" />

      {/* Content area */}
      <div className={nodeContent}>
        {/* Header row */}
        <div className={nodeHeader}>
          <span className="text-sm shrink-0">{'\u270B'}</span>
          <span className={cn(nodeLabel, "text-muted-foreground")}>
            Intervention
          </span>
        </div>

        {/* User label if subAgentId or label differs */}
        {data.label && data.label !== data.content && (
          <div className="text-[11px] text-accent-orange font-semibold mb-1 truncate">
            {data.label}
          </div>
        )}

        {/* Truncated message */}
        <div className={cn("text-xs text-foreground leading-normal", truncate2)}>
          {data.content || '(empty)'}
        </div>
      </div>

      {/* Handles */}
      <Handle type="target" position={Position.Top} style={handleStyle(ACCENT)} />
      <Handle type="source" position={Position.Bottom} style={handleStyle(ACCENT)} />
    </div>
  );
});
