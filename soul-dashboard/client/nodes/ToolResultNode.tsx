/**
 * ToolResultNode - 도구 실행 결과 노드
 *
 * 성공(green) / 에러(red)에 따라 색상이 바뀝니다.
 * tool_call 노드의 right handle에서 이 노드의 left handle로 연결됩니다.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../lib/layout-engine';
import { cn } from '../lib/cn';
import { nodeBase, nodeBgDefault, nodeContent, nodeHeader, nodeLabel, truncate2, handleStyle } from './node-styles';

type ToolResultNodeType = Node<GraphNodeData, 'tool_result'>;

const COLOR_SUCCESS = '#22c55e';
const COLOR_ERROR = '#ef4444';

/** 실행 시간을 사람이 읽기 좋은 형식으로 포맷 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export const ToolResultNode = memo(function ToolResultNode({ data, selected }: NodeProps<ToolResultNodeType>) {
  const isError = data.isError ?? false;
  const accent = isError ? COLOR_ERROR : COLOR_SUCCESS;
  const icon = isError ? '\u274C' : '\u2705';

  return (
    <div
      data-testid="tool-result-node"
      className={cn(
        nodeBase, nodeBgDefault,
        "border relative",
        selected
          ? isError ? "border-accent-red" : "border-success"
          : "border-border",
      )}
    >
      {/* Left accent bar */}
      <div
        className="w-1 shrink-0 rounded-l-lg"
        style={{ background: accent }}
      />

      {/* Content area */}
      <div className={nodeContent}>
        {/* Header row */}
        <div className={nodeHeader}>
          <span className="text-sm shrink-0">{icon}</span>
          <span className={cn(nodeLabel, "text-muted-foreground")}>
            {isError ? 'Error' : 'Result'}
          </span>
          {data.toolName && (
            <span
              className="ml-auto text-[10px] text-muted-foreground/60 truncate max-w-[100px] font-mono"
            >
              {data.toolName}
            </span>
          )}
        </div>

        {/* Truncated result text */}
        <div
          className={cn(
            "text-xs leading-normal",
            isError ? "text-destructive-foreground" : "text-muted-foreground",
            truncate2,
            "font-mono",
          )}
        >
          {data.toolResult || data.content || '(no result)'}
        </div>
      </div>

      {/* Duration badge (bottom-right) */}
      {data.durationMs !== undefined && data.durationMs > 0 && (
        <div className="absolute bottom-1 right-2 text-[10px] text-muted-foreground/60 font-mono">
          {formatDuration(data.durationMs)}
        </div>
      )}

      {/* Handles */}
      <Handle type="target" position={Position.Left} id="left" style={handleStyle(accent)} />
      <Handle type="source" position={Position.Bottom} style={handleStyle(accent)} />
    </div>
  );
});
