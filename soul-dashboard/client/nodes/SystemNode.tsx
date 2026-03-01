/**
 * SystemNode - 시스템 이벤트 노드
 *
 * 세션 시작, 완료, 오류 등 시스템 레벨 이벤트를 표시합니다.
 * 다른 노드보다 작고 컴팩트한 디자인입니다.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../lib/layout-engine';
import { cn } from '../lib/cn';
import { nodeBase, nodeBgDefault, nodeHeader, nodeLabel, truncate2, handleStyleSmall } from './node-styles';

type SystemNodeType = Node<GraphNodeData, 'system'>;

const COLOR_NORMAL = '#6b7280';
const COLOR_ERROR = '#ef4444';

export const SystemNode = memo(function SystemNode({ data, selected }: NodeProps<SystemNodeType>) {
  const isError = data.isError ?? false;
  const accent = isError ? COLOR_ERROR : COLOR_NORMAL;

  return (
    <div
      data-testid="system-node"
      className={cn(
        nodeBase, nodeBgDefault,
        "border shadow-[0_1px_4px_rgba(0,0,0,0.3)]",
        selected
          ? isError ? "border-accent-red" : "border-muted-foreground"
          : "border-border",
      )}
    >
      {/* Left accent bar */}
      <div
        className="w-[3px] shrink-0 rounded-l-lg"
        style={{ background: accent }}
      />

      {/* Content area */}
      <div className="flex-1 px-3 py-2.5 min-w-0">
        {/* Header row */}
        <div className={nodeHeader}>
          <span className="text-sm shrink-0">{'\u2699\uFE0F'}</span>
          <span className={cn(
            nodeLabel,
            isError ? "text-accent-red" : "text-muted-foreground",
          )}>
            {data.label || 'System'}
          </span>
        </div>

        {/* Content text */}
        <div className={cn(
          "text-xs leading-normal",
          isError ? "text-destructive-foreground" : "text-muted-foreground",
          truncate2,
        )}>
          {data.content || ''}
        </div>
      </div>

      {/* Handles */}
      <Handle type="target" position={Position.Top} style={handleStyleSmall(accent)} />
      <Handle type="source" position={Position.Bottom} style={handleStyleSmall(accent)} />
    </div>
  );
});
