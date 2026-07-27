import { memo, useRef, useState } from "react";
import type { InputRequestQuestion } from "@shared/types";
import type { ChatMessage } from "../../lib/flatten-tree";
import {
  INPUT_RESPONSE_ERROR_MESSAGE,
  submitInputResponse,
} from "../../lib/input-request-actions";
import { useInputRequestTimer } from "../../hooks/useInputRequestTimer";
import { formatTime } from "../../lib/input-request-utils";
import { Button } from "../ui/button";
import { InputRequestAnswerForm } from "../InputRequestAnswerForm";
import { InputRequestOptionContent } from "../InputRequestOptionContent";
import { useGlassSurface } from "../LiquidGlassProvider";

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
  const [submissionFailed, setSubmissionFailed] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const webglActive = useGlassSurface(cardRef, { enabled: true });

  const question: InputRequestQuestion | undefined = msg.questions?.[0];
  if (!question) return null;

  const handleSelect = async (answer: string) => {
    if (selectedAnswer || msg.responded || msg.expired || isExpired) return;
    if (!msg.requestId) return;
    setSubmissionFailed(false);
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
      setSubmissionFailed(true);
    }
  };

  const isDisabled = !!selectedAnswer || !!msg.responded || !!msg.expired || isExpired;
  const isDone = !!selectedAnswer || !!msg.responded;
  const isTimedOut = msg.expired || (isExpired && !isDone);

  return (
    <div className="px-3 py-1.5" data-tree-node-id={msg.treeNodeId}>
      <div
        ref={cardRef}
        className="flex flex-col gap-2 rounded-[18px] border border-glass-border glass-strong glass-shadow-md px-4 py-3"
        data-liquid-glass-webgl={webglActive ? "true" : undefined}
      >
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
          <div className="text-xs chat-tone-success-text">✅ {selectedAnswer || '응답 완료'}</div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {question.options?.map((opt) => (
                <Button
                  key={opt.label}
                  variant="choice"
                  onClick={() => handleSelect(opt.label)}
                  disabled={isDisabled}
                  data-selected={selectedAnswer === opt.label ? "true" : undefined}
                  className="w-full px-3 py-2.5 text-sm disabled:cursor-default"
                >
                  <InputRequestOptionContent option={opt} descriptionClassName="text-xs" />
                </Button>
              ))}
            </div>
            <InputRequestAnswerForm
              value={customAnswer}
              onValueChange={setCustomAnswer}
              inputDisabled={isDisabled}
              submitDisabled={isDisabled || !customAnswer.trim()}
              inputTextClassName="text-sm"
              onSubmit={(event) => {
                event.preventDefault();
                const answer = customAnswer.trim();
                if (answer) void handleSelect(answer);
              }}
            />
            {submissionFailed && (
              <div role="alert" className="text-xs text-destructive">
                {INPUT_RESPONSE_ERROR_MESSAGE}
              </div>
            )}
            <div className="text-right text-xs text-muted-foreground">⏱️ {formatTime(remainingSec)}</div>
          </>
        )}
      </div>
    </div>
  );
});
