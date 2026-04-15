import { memo, useState } from "react";
import type { InputRequestQuestion } from "@shared/types";
import type { ChatMessage } from "../../lib/flatten-tree";
import { submitInputResponse } from "../../lib/input-request-actions";
import { useInputRequestTimer } from "../../hooks/useInputRequestTimer";
import { formatTime } from "../../lib/input-request-utils";
import { cn } from "../../lib/cn";

export const ChatInputRequest = memo(function ChatInputRequest({
  msg,
  sessionId,
}: {
  msg: ChatMessage;
  sessionId: string;
}) {
  const { remainingSec, isExpired } = useInputRequestTimer(msg.receivedAt, msg.timeoutSec ?? 300);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);

  const question: InputRequestQuestion | undefined = msg.questions?.[0];
  if (!question) return null;

  const handleSelect = async (answer: string) => {
    if (selectedAnswer || msg.responded || msg.expired || isExpired) return;
    if (!msg.requestId) return;
    setSelectedAnswer(answer);  // 낙관적 UI
    const success = await submitInputResponse(
      sessionId,
      msg.requestId,
      msg.id,
      question.question,
      answer
    );
    if (!success) {
      setSelectedAnswer(null);  // 실패 시 롤백
    }
  };

  const isDisabled = !!selectedAnswer || !!msg.responded || !!msg.expired || isExpired;
  const isDone = !!selectedAnswer || !!msg.responded;
  const isTimedOut = msg.expired || (isExpired && !isDone);

  return (
    <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0 text-center">🔔</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground mb-1">Claude가 질문합니다</div>
        {question.header && (
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{question.header}</div>
        )}
        <div className="text-base font-medium text-foreground mb-2">{question.question}</div>
        {isTimedOut ? (
          <div className="text-xs text-muted-foreground">⏱️ 시간 초과</div>
        ) : isDone ? (
          <div className="text-xs text-success">✅ {selectedAnswer || '응답 완료'}</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {question.options?.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => handleSelect(opt.label)}
                  disabled={isDisabled}
                  className={cn(
                    "px-3 py-1 rounded text-xs border transition-colors",
                    "border-border bg-input text-foreground",
                    "hover:bg-muted/50 disabled:opacity-50 disabled:cursor-default",
                  )}
                >
                  {opt.label}
                  {opt.description && (
                    <span className="text-muted-foreground ml-1 text-xs">— {opt.description}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="text-xs text-muted-foreground">⏱️ {formatTime(remainingSec)}</div>
          </>
        )}
      </div>
    </div>
  );
});
