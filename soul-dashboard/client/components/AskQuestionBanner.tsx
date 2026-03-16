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
import type { EventTreeNode, InputRequestNodeDef, InputRequestQuestion } from '@shared/types';

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

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
  const { remainingSec, isExpired } = useInputRequestTimer(node.receivedAt, 300);
  const [responded, setResponded] = useState(false);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (isExpired && !responded) {
      expireInputRequest(node.id);
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
    setSelectedAnswer(answer);
    const success = await submitInputResponse(
      sessionId,
      node.requestId,
      node.id,
      question.question,
      answer
    );
    if (success) setResponded(true);
  };

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        background: 'var(--background, #1e1e2e)',
        border: '1px solid var(--border, #444)',
        borderRadius: 12,
        padding: '16px 20px',
        minWidth: 320,
        maxWidth: 500,
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        transition: 'opacity 300ms ease-out',
        opacity: responded ? 1 : 1,
      }}
    >
      {responded ? (
        <div style={{ textAlign: 'center', color: '#4caf50' }}>✅ 응답 완료</div>
      ) : isExpired ? (
        <div style={{ textAlign: 'center', color: 'var(--muted-foreground, #888)' }}>⏱️ 시간 초과</div>
      ) : (
        <>
          <div style={{ marginBottom: 8, fontSize: 13, opacity: 0.7 }}>🔔 Claude가 질문합니다</div>
          {question.header && (
            <div style={{ marginBottom: 4, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.6 }}>
              {question.header}
            </div>
          )}
          <div style={{ marginBottom: 12, fontWeight: 500 }}>{question.question}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {question.options?.map((opt) => (
              <button
                key={opt.label}
                onClick={() => handleSelect(opt.label)}
                disabled={!!selectedAnswer}
                style={{
                  padding: '6px 14px',
                  borderRadius: 6,
                  border: '1px solid var(--border, #555)',
                  background: selectedAnswer === opt.label ? '#4caf50' : 'var(--popover, #2a2a3e)',
                  color: 'var(--foreground, #fff)',
                  cursor: selectedAnswer ? 'default' : 'pointer',
                  fontSize: 13,
                  transition: 'background 150ms',
                }}
              >
                {opt.label}
                {opt.description && (
                  <span style={{ marginLeft: 4, opacity: 0.6, fontSize: 11 }}>— {opt.description}</span>
                )}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 12, opacity: 0.6, textAlign: 'right' }}>
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
