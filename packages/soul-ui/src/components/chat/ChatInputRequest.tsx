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
  const [customAnswer, setCustomAnswer] = useState("");

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
    <div className="px-3 py-1.5" data-tree-node-id={msg.treeNodeId}>
      <div className="flex flex-col gap-2 rounded-[18px] border border-glass-border glass-strong glass-shadow-md px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Question
        </div>
        {question.header && (
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{question.header}</div>
        )}
        <div className="text-sm font-semibold leading-[1.5] text-foreground">{question.question}</div>
        {isTimedOut ? (
          <div className="text-xs text-muted-foreground">⏱️ 시간 초과</div>
        ) : isDone ? (
          <div className="text-xs text-success">✅ {selectedAnswer || '응답 완료'}</div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {question.options?.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => handleSelect(opt.label)}
                  disabled={isDisabled}
                  className={cn(
                    "rounded-[13px] border border-[var(--lg-line)] bg-muted/40 px-3 py-2.5 text-left text-sm transition-colors",
                    selectedAnswer === opt.label
                      ? "border-accent-blue/55 bg-accent-blue/15"
                      : "hover:border-accent-blue/50",
                    "disabled:cursor-default disabled:opacity-50",
                  )}
                >
                  <b className="font-semibold">{opt.label}</b>
                  {opt.description && (
                    <small className="mt-0.5 block text-xs leading-[1.45] text-muted-foreground">
                      {opt.description}
                    </small>
                  )}
                </button>
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
                disabled={isDisabled}
                placeholder="직접 입력"
                className="min-w-0 flex-1 rounded-[13px] border border-[var(--lg-line)] bg-muted/40 px-3 py-2 text-sm outline-none transition-colors focus:border-accent-blue/55"
              />
              <button
                type="submit"
                disabled={isDisabled || !customAnswer.trim()}
                className="rounded-full bg-gradient-to-b from-[#2E96FF] to-[#0A84FF] px-3 text-xs font-semibold text-white disabled:opacity-50"
              >
                전송
              </button>
            </form>
            <div className="text-right text-xs text-muted-foreground">⏱️ {formatTime(remainingSec)}</div>
          </>
        )}
      </div>
    </div>
  );
});
