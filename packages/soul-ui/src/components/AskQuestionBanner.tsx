/**
 * AskQuestionBanner - 화면 상단 중앙의 AskUserQuestion 배너
 *
 * 현재 세션의 트리에서 미응답·미만료 input_request 노드를 찾아
 * 화면 상단 중앙에 fixed 오버레이로 표시합니다.
 * 응답 또는 타임아웃 시 배너를 숨기고 트리 상태를 갱신합니다.
 */

import { useEffect, useState } from 'react';
import { useDashboardStore, type DashboardState, type DashboardActions } from '../stores/dashboard-store';
import { submitInputResponse, submitToolApproval } from '../lib/input-request-actions';
import { useInputRequestTimer } from '../hooks/useInputRequestTimer';
import { formatTime } from '../lib/input-request-utils';
import type { EventTreeNode, InputRequestNodeDef, InputRequestQuestion, ToolApprovalNodeDef } from '@shared/types';
import { LiquidGlassCard } from './LiquidGlassCard';
import { Button } from './ui/button';

type PendingPromptNode = InputRequestNodeDef | ToolApprovalNodeDef;

const PROMPT_BANNER_FRAME_CLASS =
  "fixed left-1/2 top-6 z-[1000] flex w-[min(720px,calc(100vw-2rem))] max-w-3xl -translate-x-1/2 flex-col gap-2 rounded-[18px] border border-glass-border glass-shadow-lg px-4 py-3";

/** 트리를 재귀 순회하여 미응답·미만료 input_request 노드를 반환 */
function findPendingPrompt(nodes: EventTreeNode[]): PendingPromptNode | null {
  for (const node of nodes) {
    if (
      node.type === 'input_request' &&
      !(node as InputRequestNodeDef).responded &&
      !(node as InputRequestNodeDef).expired
    ) {
      return node as InputRequestNodeDef;
    }
    if (
      node.type === 'tool_approval' &&
      !(node as ToolApprovalNodeDef).resolved
    ) {
      return node as ToolApprovalNodeDef;
    }
    if (node.children && node.children.length > 0) {
      const found = findPendingPrompt(node.children);
      if (found) return found;
    }
  }
  return null;
}

interface AskQuestionBannerInnerProps {
  node: PendingPromptNode;
  sessionId: string;
}

function AskQuestionBannerInner({ node, sessionId }: AskQuestionBannerInnerProps) {
  if (node.type === 'tool_approval') {
    return <ToolApprovalBanner node={node} sessionId={sessionId} />;
  }
  return <InputRequestBanner node={node} sessionId={sessionId} />;
}

function ToolApprovalBanner({ node, sessionId }: { node: ToolApprovalNodeDef; sessionId: string }) {
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const handleDecision = async (decision: "approved" | "rejected") => {
    if (selectedAnswer) return;
    setSelectedAnswer(decision);
    const success = await submitToolApproval(
      sessionId,
      node.approvalId,
      node.id,
      decision,
      decision === "rejected" ? "Rejected by user" : undefined,
    );
    if (!success) {
      setSelectedAnswer(null);
    }
  };

  return (
    <LiquidGlassCard
      data-testid="tool-approval-banner"
      className={PROMPT_BANNER_FRAME_CLASS}
    >
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Approval</div>
      <div className="font-medium text-foreground">{node.toolName}</div>
      {node.agentName && (
        <div className="text-xs text-muted-foreground">{node.agentName}</div>
      )}
      <pre className="max-h-32 overflow-auto rounded-[13px] border border-[var(--lg-line)] bg-muted/40 p-2 text-xs text-muted-foreground">
        {JSON.stringify(node.toolInput, null, 2)}
      </pre>
      <div className="flex justify-end gap-2">
        <Button
          variant="destructive-outline"
          size="xs"
          onClick={() => handleDecision("rejected")}
          disabled={!!selectedAnswer}
          className="h-auto rounded-full px-3.5 py-1.5 text-xs font-normal disabled:cursor-default"
        >
          거부
        </Button>
        <Button
          variant="success"
          size="xs"
          onClick={() => handleDecision("approved")}
          disabled={!!selectedAnswer}
          className="h-auto rounded-full px-3.5 py-1.5 text-xs font-semibold disabled:cursor-default"
        >
          승인
        </Button>
      </div>
    </LiquidGlassCard>
  );
}

function InputRequestBanner({ node, sessionId }: { node: InputRequestNodeDef; sessionId: string }) {
  const expireInputRequest = useDashboardStore((s: DashboardState & DashboardActions) => s.expireInputRequest);
  const { remainingSec, isExpired } = useInputRequestTimer(node.receivedAt, node.timeoutSec ?? 300);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [customAnswer, setCustomAnswer] = useState("");

  // 두 만료 경로 통합: 클라이언트 타이머(isExpired) 또는 서버 이벤트(serverExpiredAt)
  const isEffectivelyExpired = isExpired || !!node.serverExpiredAt;

  useEffect(() => {
    if (isEffectivelyExpired) {
      // expireInputRequest를 즉시 호출하면 expired=true → findPendingInputRequest 필터링 → 배너 즉시 사라짐
      // 2초 후에 호출하여 그 동안 "⏱️ 시간 초과" 메시지 표시
      const timer = setTimeout(() => expireInputRequest(node.id), 2000);
      return () => clearTimeout(timer);
    }
  }, [isEffectivelyExpired, node.id, expireInputRequest]);

  const question: InputRequestQuestion | undefined = node.questions[0];
  if (!question) return null;

  const handleSelect = async (answer: string) => {
    if (selectedAnswer) return;
    setSelectedAnswer(answer);  // 낙관적 UI: 버튼 즉시 비활성화
    const success = await submitInputResponse(
      sessionId,
      node.requestId,
      node.id,
      question.question,
      answer
    );
    if (!success) {
      setSelectedAnswer(null);  // 실패 시 롤백
    }
    // 성공 시 상태 갱신은 SSE로 돌아오는 input_request_responded 이벤트가 처리한다.
    // responded=true → findPendingInputRequest 필터링 → 배너 컴포넌트 언마운트
  };

  return (
    <LiquidGlassCard
      data-testid="ask-question-banner"
      className={PROMPT_BANNER_FRAME_CLASS}
    >
      {isEffectivelyExpired ? (
        <div className="text-center text-muted-foreground">시간 초과</div>
      ) : (
        <>
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Question</div>
          {question.header && (
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {question.header}
            </div>
          )}
          <div className="text-[12.5px] font-semibold leading-[1.5] text-foreground">{question.question}</div>
          <div className="flex flex-col gap-2">
            {question.options?.map((opt) => (
              <Button
                key={opt.label}
                variant="choice"
                onClick={() => handleSelect(opt.label)}
                disabled={!!selectedAnswer}
                data-selected={selectedAnswer === opt.label ? "true" : undefined}
                className="w-full px-3 py-2.5 text-[12.5px] disabled:cursor-default"
              >
                <b className="font-semibold">{opt.label}</b>
                {opt.description && (
                  <small className="mt-0.5 block text-[11.5px] leading-[1.45] text-muted-foreground">
                    {opt.description}
                  </small>
                )}
              </Button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const answer = customAnswer.trim();
              if (answer) void handleSelect(answer);
            }}
          >
            <input
              value={customAnswer}
              onChange={(event) => setCustomAnswer(event.target.value)}
              disabled={!!selectedAnswer}
              placeholder="직접 입력"
              className="min-w-0 flex-1 rounded-[13px] border border-[var(--lg-line)] bg-muted/40 px-3 py-2 text-xs outline-none transition-colors focus:border-accent-blue/55"
            />
            <Button
              type="submit"
              size="xs"
              disabled={!!selectedAnswer || !customAnswer.trim()}
              className="h-auto self-stretch rounded-full px-3 text-xs font-semibold"
            >
              전송
            </Button>
          </form>
          {!isEffectivelyExpired && (
            <div className="text-xs text-muted-foreground text-right">
              {formatTime(remainingSec)}
            </div>
          )}
        </>
      )}
    </LiquidGlassCard>
  );
}

export function AskQuestionBanner() {
  const activeSessionKey = useDashboardStore((s: DashboardState & DashboardActions) => s.activeSessionKey);
  const tree = useDashboardStore((s: DashboardState & DashboardActions) => s.tree);
  // treeVersion을 구독하여 트리 변경 시 리렌더 트리거
  useDashboardStore((s: DashboardState & DashboardActions) => s.treeVersion);

  if (!tree || !activeSessionKey) return null;

  // 트리 루트부터 순회 (session 루트의 children 포함)
  const pendingNode = findPendingPrompt([tree]);
  if (!pendingNode) return null;

  return <AskQuestionBannerInner node={pendingNode} sessionId={activeSessionKey} />;
}
