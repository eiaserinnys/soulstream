/**
 * ToolCallNode - 도구 호출 노드
 *
 * 헤더에 도구 이름(대문자)을 표시하고, 입력 파라미터를 2줄로 보여줍니다.
 * streaming 상태(결과 대기 중)일 때 pulsing border를 표시합니다.
 * 플랜 모드 진입/종료 노드는 시안 계열로 시각적 구분됩니다.
 */

import { memo, useCallback } from 'react';
import { type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../../lib/layout-engine';
import { cn } from '../../lib/cn';
import { nodeBase, nodeContent, nodeHeader, nodeLabel, collapseButton, truncate2, NODE_COLORS } from './node-styles';
import { NodeHandles } from './NodeHandles';
import { useDashboardStore } from '../../stores/dashboard-store';

type ToolCallNodeType = Node<GraphNodeData, 'tool_call'>;

/** 도구별 입력 파라미터를 읽기 쉬운 형태로 변환 */
function formatInputPreview(toolName: string | undefined, input?: Record<string, unknown>): string {
  if (!input) return '';
  const name = toolName ?? '';

  if (name === 'Bash' && typeof input.command === 'string') {
    return input.command;
  }
  if (name === 'Read' && typeof input.file_path === 'string') {
    return input.file_path;
  }

  // 기타 도구: 첫 번째 키의 값이 문자열이면 그대로, 아니면 JSON
  const keys = Object.keys(input);
  if (keys.length > 0) {
    const firstValue = input[keys[0]];
    if (typeof firstValue === 'string') return firstValue;
  }
  return JSON.stringify(input);
}

/** 도구 카테고리별 설정 — color는 CSS 변수를 참조 */
const CATEGORY_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  skill: { label: "SKILL", color: NODE_COLORS.skill, icon: "\u{2728}" },
  "sub-agent": { label: "AGENT", color: NODE_COLORS.plan, icon: "\u{1F916}" },
};

export const ToolCallNode = memo(function ToolCallNode({ data, selected }: NodeProps<ToolCallNodeType>) {
  const isStreaming = data.streaming;
  const isPlanEntry = data.isPlanModeEntry;
  const isPlanExit = data.isPlanModeExit;
  const isPlanMode = data.isPlanMode;
  const category = data.toolCategory;
  const categoryConfig = category ? CATEGORY_CONFIG[category] : undefined;
  const toggleNodeCollapse = useDashboardStore((s) => s.toggleNodeCollapse);

  const handleCollapseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (data.cardId) {
      toggleNodeCollapse(data.cardId);
    }
  }, [data.cardId, toggleNodeCollapse]);

  // 플랜 모드 진입/종료 노드는 시안 계열로 시각적 구분
  const accentColor = (isPlanEntry || isPlanExit)
    ? NODE_COLORS.plan
    : categoryConfig?.color ?? NODE_COLORS.tool;

  // 상태 아이콘 결정
  const isCompleted = !isStreaming;
  const statusIcon = isPlanEntry
    ? '\u{1F4CB}'
    : isPlanExit
      ? '\u{2705}'
      : categoryConfig?.icon
        ? categoryConfig.icon
        : isCompleted && data.isError
          ? '\u{274C}'
          : isCompleted
            ? '\u{2705}'
            : '\u{1F528}';

  // 헤더 라벨 텍스트
  const headerLabel = isPlanEntry
    ? 'Plan Mode'
    : isPlanExit
      ? 'Plan Exit'
      : (data.toolName ?? 'unknown').toUpperCase();

  return (
    <div
      data-testid="tool-call-node"
      className={cn(
        nodeBase,
        "border",
        isPlanMode ? "bg-node-plan/6" : "bg-card",
        selected
          ? isPlanEntry || isPlanExit ? "border-node-plan" : "border-node-tool"
          : isPlanMode
            ? "border-node-plan/25"
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
            {statusIcon}
          </span>
          <span className={cn(
            nodeLabel,
            (isPlanEntry || isPlanExit) ? "text-node-plan" : "text-muted-foreground",
          )}>
            {headerLabel}
          </span>
          {/* 카테고리 배지 (SKILL / AGENT) */}
          {categoryConfig && !isPlanEntry && !isPlanExit && (
            <span
              className="text-[9px] font-bold px-[5px] py-px rounded-[3px]"
              style={{ color: categoryConfig.color, backgroundColor: `color-mix(in srgb, ${categoryConfig.color} 12%, transparent)` }}
            >
              {categoryConfig.label}
            </span>
          )}
          {isStreaming && (
            <span className="ml-auto text-[10px] font-medium" style={{ color: accentColor }}>
              running...
            </span>
          )}
          {isPlanMode && !isPlanEntry && !isPlanExit && !categoryConfig && (
            <span className="ml-auto text-[9px] text-node-plan font-medium px-[5px] py-px rounded-[3px] bg-node-plan/12">
              PLAN
            </span>
          )}
          {data.hasChildren && !isStreaming && (
            <button
              type="button"
              className={cn(collapseButton, "ml-auto")}
              onClick={handleCollapseClick}
              aria-label={data.collapsed ? "Expand node" : "Collapse node"}
            >
              {data.collapsed ? `▶ (${data.childCount})` : "▼"}
            </button>
          )}
        </div>

        {/* Input params (2-line clamp) */}
        {data.toolInput && (
          <div
            className={cn("text-[11px] text-muted-foreground font-mono whitespace-pre-wrap", truncate2)}
          >
            {formatInputPreview(data.toolName, data.toolInput)}
          </div>
        )}
      </div>

      {/* Handles */}
      <NodeHandles color={accentColor} />
    </div>
  );
});
