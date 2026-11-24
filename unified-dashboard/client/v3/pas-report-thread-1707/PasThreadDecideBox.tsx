import { useRef, useState, type RefObject } from "react";
import { Badge, Button } from "@seosoyoung/soul-ui";
import { ChatInputEditor } from "@seosoyoung/soul-ui/components/chat/ChatInputEditor";
import { X } from "lucide-react";
import { CardQuestionActions, CardQuestionNotice } from "../CardQuestionBlock";
import { questionView } from "./PasThreadTimeline";
import type { Agenda, DispositionId } from "./pas-report-thread-1707-data";

export type DecisionTarget = { checkId: string; label: string } | null;
export type QuestionMode = "followup" | "answer";

export function PasThreadDecideBox({ agenda, target, onClearTarget, text, onChangeText, onSend, onDispose,
  questionAnswer, onChooseQuestion, undoLabel, onUndo, onSnooze, onUnsnooze, onSimulate, undoButtonRef }: {
  agenda: Agenda;
  target: DecisionTarget;
  onClearTarget(): void;
  text: string;
  onChangeText(value: string): void;
  onSend(mode: QuestionMode): void;
  onDispose(disposition: DispositionId): void;
  questionAnswer: string | null;
  onChooseQuestion(label: string): void;
  undoLabel: string | null;
  onUndo(): void;
  onSnooze(label: string): void;
  onUnsnooze(): void;
  onSimulate(): void;
  undoButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [askBack, setAskBack] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const focusComposer = () => requestAnimationFrame(() => requestAnimationFrame(() => composerRef.current?.querySelector("textarea")?.focus()));
  const settled = agenda.status === "done" || agenda.status === "awaiting_verification";
  const choiceQuestion = agenda.question?.kind === "choice" ? agenda.question : null;
  const openQuestion = choiceQuestion && questionAnswer === null && agenda.status === "review" && !agenda.snoozedLabel;
  return <footer className="pas-rt1707-decide" aria-label="결재 상자" onKeyDown={(event) => {
    if (event.key === "Escape" && snoozeOpen) { event.preventDefault(); event.stopPropagation(); setSnoozeOpen(false); }
  }}>
    <div className="pas-rt1707-decide-phase-row">
      <span className="pas-rt1707-decide-phase">{agenda.status === "running" ? "진행 중" : "5. 결재"}</span>
      {target ? <span className="pas-rt1707-target-chip">
        <span>대상: {target.label}</span>
        <button type="button" className="pas-rt1707-target-clear" aria-label="대상 해제" onClick={onClearTarget}><X className="size-3.5" strokeWidth={1.6} aria-hidden="true" /></button>
      </span> : agenda.snoozedLabel ? <span className="pas-rt1707-decide-hint">미뤄 둠: {agenda.snoozedLabel}</span> : null}
    </div>
    {openQuestion && askBack ? <CardQuestionNotice label="되묻기" onClear={() => { setAskBack(false); focusComposer(); }} /> : null}
    <div ref={composerRef} className="pas-rt1707-decide-input">
      <ChatInputEditor presentation="manuscript" inputLabel="결재 지시" text={text} onChangeText={onChangeText}
        onSend={() => { onSend(openQuestion && askBack ? "followup" : "answer"); setAskBack(false); }}
        placeholder={target ? `${target.label}에 보탤 지시를 적으세요` : openQuestion ? (askBack ? "물어볼 것" : "다르게 답하기") : "이 안건에 보탤 지시나 답을 적으세요"}
        buttonLabel="지시 보내기" modeIcon="" modeLabel="" borderColor="" buttonVariant="default"
        disabled={text.trim().length === 0} textareaDisabled={false} />
    </div>
    <div className="pas-rt1707-decide-actions">
      <div className="pas-rt1707-stamps">
        <div className="pas-rt1707-stamps-primary">
          {agenda.snoozedLabel ? <Button variant="outline" size="sm" onClick={onUnsnooze}>미루기 해제</Button> : <>
            {choiceQuestion ? (questionAnswer === null
              ? choiceQuestion.options.map((option) => <Button key={option.label} variant="choice" size="sm" className="pas-rt1707-choice"
                  onClick={() => onChooseQuestion(option.label)}><span>{option.label}</span>
                  {option.recommended ? <Badge variant="info" size="sm">권함</Badge> : null}</Button>)
              : <span className="pas-rt1707-answer-line">받은 답: <strong>{questionAnswer}</strong></span>)
              : <>
                {agenda.primary ? <Button variant="default" size="sm" disabled={settled || agenda.status === "running"} onClick={() => onDispose(agenda.primary!.id)}>{agenda.primary.label}</Button> : null}
                {agenda.secondary ? <Button variant="outline" size="sm" disabled={settled || agenda.status === "running"} onClick={() => onDispose(agenda.secondary!.id)}>{agenda.secondary.label}</Button> : null}
              </>}
            {agenda.number === 1730 ? <Button variant="outline" size="sm" data-testid="pas-rt1707-simulate-event" onClick={onSimulate}>다음 경과 도착 시연</Button> : null}
          </>}
        </div>
        <div className="pas-rt1707-stamps-secondary">
          {openQuestion ? <CardQuestionActions view={questionView(choiceQuestion, null, true)} composerVisible onAnswerFreely={() => {}}
            onAskBack={() => { setAskBack(true); focusComposer(); }} /> : null}
          {agenda.status === "review" && !agenda.snoozedLabel ? <Button variant="outline" size="sm" data-testid="pas-rt1707-snooze-trigger" aria-expanded={snoozeOpen}
            onClick={() => setSnoozeOpen((value) => !value)}>답변 미루기</Button> : null}
          <div className="pas-rt1707-undo-slot">
            {undoLabel ? <Button ref={undoButtonRef} variant="ghost" size="sm" onClick={onUndo}>{undoLabel}</Button> : <span className="pas-rt1707-undo-placeholder">{settled ? "처분 완료" : ""}</span>}
          </div>
        </div>
        {snoozeOpen && !agenda.snoozedLabel ? <div className="pas-rt1707-snooze-options" aria-label="미룰 시간">
          {["1시간 뒤", "오늘 저녁", "내일 아침", "사흘 뒤"].map((label) => <Button key={label} variant="outline" size="sm" onClick={() => { setSnoozeOpen(false); onSnooze(label); }}>{label}</Button>)}
        </div> : null}
      </div>
    </div>
  </footer>;
}
