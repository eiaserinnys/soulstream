/**
 * AskQuestionBanner - 화면 하단 중앙의 AskUserQuestion 배너
 *
 * 현재 세션의 트리에서 미응답·미만료 input_request 노드를 찾아
 * NodeGraph 캔버스 위에 absolute로 오버레이 표시합니다.
 * 응답 또는 타임아웃 시 배너를 숨기고 트리 상태를 갱신합니다.
 */

import { useEffect, useState } from 'react';
import { useDashboardStore, type DashboardState, type DashboardActions } from '../stores/dashboard-store';
import { submitInputResponse } from '../lib/input-request-actions';
import { useInputRequestTimer } from '../hooks/useInputRequestTimer';
import { formatTime } from '../lib/input-request-utils';
import { cn } from '../lib/cn';
import type { EventTreeNode, InputRequestNodeDef, InputRequestQuestion } from '@shared/types';

/** 트리를 재귀 순회하여 미응답·미만료 input_request 노드를 반환 */
function findPendingInputRequest(nodes: EventTreeNode[]): InputRequestNodeDef | null {
  for (const node of nodes) {
    if (
      node.type === 'input_request' &&
      !(node as InputRequestNodeDef).responded &&
      !(node as InputRequestNodeDef).expired
    ) {
      return node as InputRequestNodeDef;
    }
    if (node.children && node.children.length > 0) {
      const found = findPendingInputRequest(node.children);
      if (found) return found;
    }
  }
  return null;
}

interface AskQuestionBannerInnerProps {
  node: InputRequestNodeDef;
  sessionId: string;
}

function AskQuestionBannerInner({ node, sessionId }: AskQuestionBannerInnerProps) {
  const expireInputRequest = useDashboardStore((s: DashboardState & DashboardActions) => s.expireInputRequest);
  const { remainingSec, isExpired } = useInputRequestTimer(node.receivedAt, node.timeoutSec ?? 300);
  const [responded, setResponded] = useState(false);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (isExpired && !responded) {
      expireInputRequest(node.id);
      const timer = setTimeout(() => setVisible(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [isExpired, responded, node.id, expireInputRequest]);

  useEffect(() => {
    if (responded) {
      const timer = setTimeout(() => setVisible(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [responded]);

  if (!visible) return null;

  const question: InputRequestQuestion | undefined = node.questions[0];
  if (!question) return null;

  const handleSelect = async (answer: string) => {
    if (selectedAnswer) return;
    setSelectedAnswer(answer);  // 낙관적 UI
    const success = await submitInputResponse(
      sessionId,
      node.requestId,
      node.id,
      question.question,
      answer
    );
    if (success) {
      setResponded(true);
    } else {
      setSelectedAnswer(null);  // 실패 시 롤백
    }
  };

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000] bg-background border border-border rounded-xl p-4 min-w-80 max-w-[500px] shadow-lg">
      {responded ? (
        <div className="text-center text-success">✅ 응답 완료</div>
      ) : isExpired ? (
        <div className="text-center text-muted-foreground">⏱️ 시간 초과</div>
      ) : (
        <>
          <div className="mb-2 text-[13px] text-muted-foreground">🔔 Claude가 질문합니다</div>
          {question.header && (
            <div className="mb-1 text-[11px] text-muted-foreground uppercase tracking-wide">
              {question.header}
            </div>
          )}
          <div className="mb-3 font-medium text-foreground">{question.question}</div>
          <div className="flex flex-wrap gap-2 mb-2">
            {question.options?.map((opt) => (
              <button
                key={opt.label}
                onClick={() => handleSelect(opt.label)}
                disabled={!!selectedAnswer}
                className={cn(
                  "px-3.5 py-1.5 rounded border text-[13px] transition-colors",
                  selectedAnswer === opt.label
                    ? "bg-success border-success text-white"
                    : "border-border bg-popover text-foreground hover:bg-muted/50",
                  "disabled:opacity-50 disabled:cursor-default",
                )}
              >
                {opt.label}
                {opt.description && (
                  <span className="ml-1 opacity-60 text-[11px]">— {opt.description}</span>
                )}
              </button>
            ))}
          </div>
          <div className="text-[12px] text-muted-foreground text-right">
            ⏱️ {formatTime(remainingSec)}
          </div>
        </>
      )}
    </div>
  );
}

export function AskQuestionBanner() {
  const activeSessionKey = useDashboardStore((s: DashboardState & DashboardActions) => s.activeSessionKey);
  const tree = useDashboardStore((s: DashboardState & DashboardActions) => s.tree);
  // treeVersion을 구독하여 트리 변경 시 리렌더 트리거
  useDashboardStore((s: DashboardState & DashboardActions) => s.treeVersion);

  if (!tree || !activeSessionKey) return null;

  // 트리 루트부터 순회 (session 루트의 children 포함)
  const pendingNode = findPendingInputRequest([tree]);
  if (!pendingNode) return null;

  return <AskQuestionBannerInner node={pendingNode} sessionId={activeSessionKey} />;
}
