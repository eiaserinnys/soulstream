/**
 * UserNode - 사용자 입력/프롬프트 노드
 *
 * 사용자가 보낸 메시지를 표시합니다.
 * 상단 target handle과 하단 source handle을 갖습니다.
 */

import { memo } from 'react';
import { type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../lib/layout-engine';
import { cn } from '../lib/cn';
import { nodeBase, nodeBgDefault, nodeContent, nodeHeader, nodeLabel, truncate2, NODE_COLORS } from './node-styles';
import { NodeHandles } from './NodeHandles';

type UserNodeType = Node<GraphNodeData, 'user'>;

export const UserNode = memo(function UserNode({ data, selected }: NodeProps<UserNodeType>) {
  return (
    <div
      data-testid="user-node"
      className={cn(
        nodeBase, nodeBgDefault,
        "border",
        selected ? "border-node-user" : "border-border",
      )}
    >
      {/* Left accent bar */}
      <div className="w-1 shrink-0 bg-node-user rounded-l-lg" />

      {/* Content area */}
      <div className={nodeContent}>
        {/* Header row */}
        <div className={nodeHeader}>
          {/* Avatar circle */}
          <div className="w-5 h-5 rounded-full bg-node-user/20 border border-node-user/40 flex items-center justify-center text-[11px] shrink-0">
            {'\u{1F464}'}
          </div>
          <span className={cn(nodeLabel, "text-muted-foreground")}>
            User
          </span>
        </div>

        {/* Truncated content */}
        <div className={cn("text-xs text-foreground leading-normal", truncate2)}>
          {data.content || data.label || '(empty)'}
        </div>
      </div>

      {/* Handles */}
      <NodeHandles color={NODE_COLORS.user} />
    </div>
  );
});
