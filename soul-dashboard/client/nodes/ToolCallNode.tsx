/**
 * ToolCallNode - 도구 호출 노드
 *
 * 도구 이름을 강조 표시하고, 입력 파라미터를 축약하여 보여줍니다.
 * streaming 상태(결과 대기 중)일 때 pulsing border를 표시합니다.
 * 플랜 모드 진입/종료 노드는 시안 계열로 시각적 구분됩니다.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../lib/layout-engine';
import { cn } from '../lib/cn';
import { nodeBase, nodeContent, nodeHeader, nodeLabel, handleStyle } from './node-styles';

type ToolCallNodeType = Node<GraphNodeData, 'tool_call'>;

const ACCENT = '#f59e0b';
const PLAN_ACCENT = '#06b6d4';

function truncateInput(input?: Record<string, unknown>): string {
  if (!input) return '';
  const str = JSON.stringify(input);
  if (str.length <= 80) return str;
  return str.slice(0, 77) + '...';
}

export const ToolCallNode = memo(function ToolCallNode({ data, selected }: NodeProps<ToolCallNodeType>) {
  const isStreaming = data.streaming;
  const isPlanEntry = data.isPlanModeEntry;
  const isPlanExit = data.isPlanModeExit;
  const isPlanMode = data.isPlanMode;

  // 플랜 모드 진입/종료 노드는 시안 계열로 시각적 구분
  const accentColor = (isPlanEntry || isPlanExit) ? PLAN_ACCENT : ACCENT;

  return (
    <div
      data-testid="tool-call-node"
      className={cn(
        nodeBase,
        "border",
        isPlanMode ? "bg-accent-cyan/6" : "bg-card",
        selected
          ? isPlanEntry || isPlanExit ? "border-accent-cyan" : "border-accent-amber"
          : isPlanMode
            ? "border-accent-cyan/25"
            : "border-border",
      )}
      style={isStreaming && !selected ? { animation: 'tool-call-pulse 2s infinite' } : undefined}
    >
      {/* Left accent bar */}
      <div
        className="w-1 shrink-0 rounded-l-lg"
        style={{ background: accentColor }}
      />

      {/* Content area */}
      <div className={nodeContent}>
        {/* Header row */}
        <div className={nodeHeader}>
          <span className="text-sm shrink-0">
            {isPlanEntry ? '\u{1F4CB}' : isPlanExit ? '\u{2705}' : '\u{1F527}'}
          </span>
          <span className={cn(
            nodeLabel,
            (isPlanEntry || isPlanExit) ? "text-accent-cyan" : "text-muted-foreground",
          )}>
            {isPlanEntry ? 'Plan Mode' : isPlanExit ? 'Plan Exit' : 'Tool Call'}
          </span>
          {isStreaming && (
            <span className="ml-auto text-[10px] font-medium" style={{ color: accentColor }}>
              running...
            </span>
          )}
          {isPlanMode && !isPlanEntry && !isPlanExit && (
            <span className="ml-auto text-[9px] text-accent-cyan font-medium px-[5px] py-px rounded-[3px] bg-accent-cyan/12">
              PLAN
            </span>
          )}
        </div>

        {/* Tool name */}
        <div
          className="text-[13px] text-foreground font-semibold mb-1 truncate font-mono"
        >
          {data.toolName || 'unknown'}
        </div>

        {/* Truncated input params */}
        {data.toolInput && (
          <div
            className="text-[11px] text-muted-foreground truncate font-mono"
          >
            {truncateInput(data.toolInput)}
          </div>
        )}
      </div>

      {/* Handles */}
      <Handle type="target" position={Position.Top} id="top" style={handleStyle(accentColor)} />
      <Handle type="target" position={Position.Left} id="left" style={handleStyle(accentColor)} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={handleStyle(accentColor)} />
      <Handle type="source" position={Position.Right} id="right" style={handleStyle(accentColor)} />
    </div>
  );
});
