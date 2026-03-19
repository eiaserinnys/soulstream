/**
 * InterventionNode - 사용자 개입 노드
 *
 * 세션 중간에 사용자가 보낸 추가 메시지/개입을 표시합니다.
 * UserNode와 비슷하지만 주황색 계열로 구분됩니다.
 */

import { memo } from 'react';
import { type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../lib/layout-engine';
import { cn } from '@seosoyoung/soul-ui';
import { nodeBase, nodeBgDefault, nodeContent, nodeHeader, nodeLabel, truncate2, NODE_COLORS } from './node-styles';
import { NodeHandles } from './NodeHandles';

type InterventionNodeType = Node<GraphNodeData, 'intervention'>;

export const InterventionNode = memo(function InterventionNode({ data, selected }: NodeProps<InterventionNodeType>) {
  return (
    <div
      data-testid="intervention-node"
      className={cn(
        nodeBase, nodeBgDefault,
        "border",
        selected ? "border-node-intervention" : "border-border",
      )}
    >
      {/* Left accent bar */}
      <div className="w-1 shrink-0 bg-node-intervention rounded-l-lg" />

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
          <div className="text-[11px] text-node-intervention font-semibold mb-1 truncate">
            {data.label}
          </div>
        )}

        {/* Truncated message */}
        <div className={cn("text-xs text-foreground leading-normal", truncate2)}>
          {data.content || '(empty)'}
        </div>
      </div>

      {/* Handles */}
      <NodeHandles color={NODE_COLORS.intervention} />
    </div>
  );
});
