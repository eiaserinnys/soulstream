import { Badge, Button } from "@seosoyoung/soul-ui";
import { ChatInputEditor } from "@seosoyoung/soul-ui/components/chat/ChatInputEditor";
import { X } from "lucide-react";
import type { Agenda, DispositionId } from "./pas-report-thread-1707-data";

export type DecisionTarget = { checkId: string; label: string } | null;

export function PasThreadDecideBox({ agenda, target, onClearTarget, text, onChangeText, onSend, onDispose,
  questionAnswer, onChooseQuestion, undoLabel, onUndo }: {
  agenda: Agenda;
  target: DecisionTarget;
  onClearTarget(): void;
  text: string;
  onChangeText(value: string): void;
  onSend(): void;
  onDispose(disposition: DispositionId): void;
  questionAnswer: string | null;
  onChooseQuestion(label: string): void;
  undoLabel: string | null;
  onUndo(): void;
}) {
  const settled = agenda.status === "done" || agenda.status === "awaiting_verification";
  const primary = agenda.primary;
  const secondary = agenda.secondary;
  const choiceQuestion = agenda.question?.kind === "choice" ? agenda.question : null;
  return <footer className="pas-rt1707-decide" aria-label="결재 상자">
    <div className="pas-rt1707-decide-phase-row">
      <span className="pas-rt1707-decide-phase">5. 결재</span>
      {target ? <span className="pas-rt1707-target-chip">
        <span>대상: {target.label}</span>
        <button type="button" className="pas-rt1707-target-clear" aria-label="대상 해제" onClick={onClearTarget}><X className="size-3.5" strokeWidth={1.6} aria-hidden="true" /></button>
      </span> : <span className="pas-rt1707-decide-hint">{hintFor(agenda)}</span>}
    </div>
    <div className="pas-rt1707-decide-input">
      <ChatInputEditor presentation="manuscript" inputLabel="결재 지시" text={text} onChangeText={onChangeText} onSend={onSend}
        placeholder={target ? `${target.label}에 보탤 지시를 적으세요` : "이 안건에 보탤 지시나 답을 적으세요"}
        buttonLabel="지시 보내기" modeIcon="" modeLabel="" borderColor="" buttonVariant="default"
        disabled={text.trim().length === 0} textareaDisabled={false} />
    </div>
    <div className="pas-rt1707-decide-actions">
      <div className={`pas-rt1707-stamps${choiceQuestion ? " pas-rt1707-stamps-choice" : ""}`} data-choice={choiceQuestion ? "true" : undefined}>
        {choiceQuestion ? (questionAnswer === null
          ? choiceQuestion.options.map((option) => <Button key={option.label} variant="choice" size="sm" className="pas-rt1707-choice"
              onClick={() => onChooseQuestion(option.label)}>
              <span>{option.label}</span>
              {option.recommended ? <Badge variant="info" size="sm">권함</Badge> : null}
            </Button>)
          : <span className="pas-rt1707-answer-line">받은 답: <strong>{questionAnswer}</strong></span>)
          : <>
            {primary ? <Button variant="default" size="sm" disabled={settled} onClick={() => onDispose(primary.id)}>{primary.label}</Button> : null}
            {secondary ? <Button variant="outline" size="sm" disabled={settled} onClick={() => onDispose(secondary.id)}>{secondary.label}</Button> : null}
            {!primary && !secondary ? <span className="pas-rt1707-stamps-empty" aria-hidden="true" /> : null}
          </>}
      </div>
      <div className="pas-rt1707-undo-slot">
        {undoLabel ? <Button variant="ghost" size="sm" onClick={onUndo}>되돌리기</Button> : <span className="pas-rt1707-undo-placeholder">{settled ? undoLabel ?? "처분 완료" : ""}</span>}
      </div>
    </div>
  </footer>;
}

function hintFor(agenda: Agenda) {
  if (agenda.status === "running") return "보낸 지시는 스레드에 바로 붙고, 이 안건은 실행 중으로 넘어갑니다.";
  if (agenda.status === "awaiting_verification") return "검증 대기로 넘어갔습니다. 보류함 수는 그대로입니다.";
  if (agenda.status === "done") return "처분을 마쳤습니다. 되돌리면 바로 앞 상태로 돌아갑니다.";
  return "지시를 보내면 이 안건에 바로 붙습니다.";
}
