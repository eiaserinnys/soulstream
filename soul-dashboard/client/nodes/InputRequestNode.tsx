/**
 * InputRequestNode - 사용자 입력 요청 노드
 *
 * AskUserQuestion 이벤트를 핑크색 노드로 표시합니다.
 * 클릭 시 오른쪽에 옵션 팝오버를 표시하고,
 * 옵션 선택 시 soul-server에 응답을 전달합니다.
 * responded 상태에 따라 이모지와 border 색상이 변경됩니다.
 *
 * 제한사항:
 * - multiSelect 질문은 지원하지 않음 (단일 선택만)
 * - 복수 질문이 있는 경우 첫 번째 질문만 응답 가능
 *   (AskUserQuestion은 대부분 단일 질문으로 사용됨)
 */

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { GraphNodeData } from '../lib/layout-engine';
import type { InputRequestQuestion } from '@shared/types';
import { cn } from '../lib/cn';
import { nodeBase, nodeBgDefault, nodeContent, nodeHeader, nodeLabel, truncate2, handleStyle, NODE_COLORS } from './node-styles';
import { useDashboardStore } from '../stores/dashboard-store';

type InputRequestNodeData = Node<GraphNodeData, 'input_request'>;

export const InputRequestNode = memo(function InputRequestNode({ data, selected }: NodeProps<InputRequestNodeData>) {
  const [showPopover, setShowPopover] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);
  const responded = data.responded ?? false;
  const questions = (data.questions ?? []) as InputRequestQuestion[];
  const requestId = data.requestId as string;
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const respondToInputRequest = useDashboardStore((s) => s.respondToInputRequest);

  // 팝오버 바깥 클릭 시 닫기 (노드 본체 클릭은 제외)
  useEffect(() => {
    if (!showPopover) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        nodeRef.current && !nodeRef.current.contains(target)
      ) {
        setShowPopover(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPopover]);

  const handleSelect = useCallback(async (question: string, label: string) => {
    if (!activeSessionKey || !requestId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(activeSessionKey)}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, answers: { [question]: label } }),
      });
      if (res.ok) {
        setShowPopover(false);
        // 트리 노드 상태를 responded=true로 갱신
        if (data.cardId) respondToInputRequest(data.cardId);
      } else {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? `Failed (${res.status})`);
      }
    } catch (err) {
      console.error('[InputRequestNode] respond failed:', err);
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  }, [activeSessionKey, requestId, submitting, data.cardId, respondToInputRequest]);

  return (
    <div className="relative">
      <div
        ref={nodeRef}
        data-testid="input-request-node"
        className={cn(
          nodeBase, nodeBgDefault,
          "border",
          !responded && "cursor-pointer",
          selected ? "border-node-input-request" : "border-border",
          !responded && "animate-pulse-border-pink",
        )}
        onClick={() => !responded && setShowPopover(!showPopover)}
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

      {/* 옵션 팝오버 */}
      {showPopover && questions.length > 0 && (
        <div
          ref={popoverRef}
          className="absolute left-[270px] top-0 z-50 w-72 bg-card border border-border rounded-lg shadow-lg p-3 space-y-3"
        >
          {questions.map((q) => (
            <div key={q.question}>
              {q.header && (
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">{q.header}</div>
              )}
              <div className="text-xs font-medium text-foreground mb-2">{q.question}</div>
              <div className="space-y-1">
                {q.options.map((opt) => (
                  <button
                    key={opt.label}
                    className="w-full text-left px-2 py-1.5 rounded text-xs hover:bg-muted/50 transition-colors disabled:opacity-50"
                    disabled={submitting}
                    onClick={(e) => { e.stopPropagation(); handleSelect(q.question, opt.label); }}
                  >
                    <span className="font-medium">{opt.label}</span>
                    {opt.description && (
                      <span className="text-muted-foreground ml-1">{'\u2014'} {opt.description}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {error && <div className="text-xs text-red-500 mt-1">{error}</div>}
        </div>
      )}
    </div>
  );
});
