/**
 * ThinkingNode - Claude의 중간 텍스트 출력 (사고/추론) 노드
 *
 * streaming 상태일 때 shimmer 애니메이션 오버레이를 표시합니다.
 * keyframes (node-shimmer, pulse)는 globals.css에 정의되어 있습니다.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../lib/layout-engine';
import { cn } from '../lib/cn';
import { nodeBase, nodeContent, nodeHeader, nodeLabel, truncate2, handleStyle } from './node-styles';

type ThinkingNodeType = Node<GraphNodeData, 'thinking'>;

const ACCENT = '#8b5cf6';
const PLAN_ACCENT = '#06b6d4';

export const ThinkingNode = memo(function ThinkingNode({ data, selected }: NodeProps<ThinkingNodeType>) {
  const isStreaming = data.streaming;
  const isPlanMode = data.isPlanMode;
  const accentColor = isPlanMode ? PLAN_ACCENT : ACCENT;

  return (
    <div
      data-testid="thinking-node"
      className={cn(
        nodeBase,
        "border relative",
        isPlanMode ? "bg-accent-cyan/6" : "bg-card",
        selected
          ? isPlanMode ? "border-accent-cyan" : "border-accent-purple"
          : isPlanMode
            ? "border-accent-cyan/25"
            : "border-border",
      )}
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
          <span className="text-sm shrink-0">{'\u{1F4AD}'}</span>
          <span className={cn(
            nodeLabel,
            isPlanMode ? "text-accent-cyan" : "text-muted-foreground",
          )}>
            Thinking
          </span>
          {isPlanMode && (
            <span className="text-[9px] text-accent-cyan font-medium px-[5px] py-px rounded-[3px] bg-accent-cyan/12">
              PLAN
            </span>
          )}
          {isStreaming && (
            <span
              className="ml-auto w-1.5 h-1.5 rounded-full shrink-0 animate-[pulse_2s_infinite]"
              style={{ background: accentColor }}
            />
          )}
        </div>

        {/* Truncated content */}
        <div className={cn("text-xs text-muted-foreground leading-normal italic", truncate2)}>
          {data.content || data.label || '(thinking...)'}
        </div>
      </div>

      {/* Shimmer overlay when streaming */}
      {isStreaming && (
        <div className={cn(
          "absolute inset-0 rounded-lg pointer-events-none",
          isPlanMode ? "shimmer-cyan" : "shimmer-purple",
        )} />
      )}

      {/* Handles */}
      <Handle type="target" position={Position.Top} style={handleStyle(accentColor)} />
      <Handle type="source" position={Position.Bottom} style={handleStyle(accentColor)} />
      <Handle type="source" position={Position.Right} id="right" style={handleStyle(accentColor)} />
    </div>
  );
});
