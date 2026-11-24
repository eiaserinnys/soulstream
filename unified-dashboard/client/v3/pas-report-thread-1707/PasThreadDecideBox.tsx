import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Badge, Button } from "@seosoyoung/soul-ui";
import { CardComposer } from "../CardComposer";
import { CardQuestionActions, CardQuestionNotice } from "../CardQuestionBlock";
import { questionView } from "./PasThreadTimeline";
import type { Agenda, DispositionId } from "./pas-report-thread-1707-data";

export type DecisionTarget = { checkId: string; label: string } | null;
export type QuestionMode = "followup" | "answer";
type ComposerMode = "closed" | "ask" | "answer" | "comment";

export function PasThreadDecideBox({ agenda, target, onClearTarget, text, onChangeText, onSend, onDispose,
  questionAnswer, onChooseQuestion, undoLabel, onUndo, onSnooze, onUnsnooze, onSimulate, undoButtonRef, onComposerToggle }: {
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
  onComposerToggle(): void;
}) {
  const [composerMode, setComposerMode] = useState<ComposerMode>("closed");
  const [focusRequest, setFocusRequest] = useState(0);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const lastComposerTriggerRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLElement>(null);
  const openComposer = (mode: ComposerMode, trigger: HTMLElement | null) => {
    lastComposerTriggerRef.current = trigger;
    setComposerMode(mode);
    setFocusRequest((value) => value + 1);
  };
  useEffect(() => {
    // 스레드의 「항목 지시」로 대상이 생기면 아래 입력창을 열고 그 단추를 돌아갈 자리로 기억한다.
    if (!target) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !footerRef.current?.contains(active)) lastComposerTriggerRef.current = active;
    setFocusRequest((value) => value + 1);
  }, [target]);
  const closeComposer = () => {
    // 입력창이 사라지기 전에 초점을 옮겨야 DialogPopup이 초점을 창 머리로 되돌리지 않는다.
    const trigger = lastComposerTriggerRef.current;
    const fallback = document.querySelector<HTMLElement>('.pas-rt1707-rail-item[data-active="true"]');
    for (const candidate of [trigger, fallback, document.querySelector<HTMLElement>(".pas-rt1707-thread-scroll")]) {
      if (!candidate?.isConnected) continue;
      candidate.focus({ preventScroll: true });
      if (document.activeElement === candidate) break;
    }
    lastComposerTriggerRef.current = null;
    if (target) onClearTarget();
    setComposerMode("closed");
  };
  const settled = agenda.status === "done" || agenda.status === "awaiting_verification";
  const choiceQuestion = agenda.question?.kind === "choice" ? agenda.question : null;
  const openQuestion = Boolean(choiceQuestion && questionAnswer === null && agenda.status === "review" && !agenda.snoozedLabel);
  // 되묻기와 다르게 답하기는 질문이 열려 있을 때만 뜻이 있다. 선택지로 답한 뒤 되돌리면 같은 입력창이 다시 보인다.
  const mode: ComposerMode = (composerMode === "ask" || composerMode === "answer") && !openQuestion ? "closed" : composerMode;
  const composerOpen = target !== null || mode !== "closed";
  // 입력창이 펼쳐지거나 접히면 스레드 높이가 바뀐다. 그린 직후 스레드가 최신 경과 바닥을 지키게 알린다.
  useLayoutEffect(() => { onComposerToggle(); }, [composerOpen]);
  const noticeLabel = target ? `대상: ${target.label}` : mode === "ask" ? "되묻기 (질문 유지)" : mode === "answer" ? "다르게 답하기" : "지시 적기";
  const placeholder = target ? `${target.label}에 보탤 지시` : mode === "ask" ? "물어볼 내용을 적으세요"
    : mode === "answer" ? "선택지 대신 보낼 답을 적으세요" : "이 안건에 보탤 지시를 적으세요";
  const sendLabel = mode === "ask" ? "되묻기 전송" : mode === "answer" ? "답변 전송" : "지시 보내기";
  const send = () => {
    if (!text.trim()) return;
    onSend(openQuestion && mode === "ask" ? "followup" : "answer");
    lastComposerTriggerRef.current = null;
    setComposerMode("closed");
  };
  const undoButton = undoLabel ? <Button ref={undoButtonRef} variant="ghost" size="sm" className="pas-rt1707-undo" onClick={onUndo}>{undoLabel}</Button> : null;
  const snoozeButton = agenda.status === "review" && !agenda.snoozedLabel ? <Button variant="outline" size="sm" data-testid="pas-rt1707-snooze-trigger"
    aria-expanded={snoozeOpen} onClick={() => setSnoozeOpen((value) => !value)}>답변 미루기</Button> : null;
  const commentButton = <Button variant="outline" size="sm" data-testid="pas-rt1707-open-composer"
    onClick={(event) => openComposer("comment", event.currentTarget)}>지시 적기</Button>;
  let primary;
  let secondary;
  if (agenda.snoozedLabel) {
    primary = <>
      <span className="pas-rt1707-decide-hint">미뤄 둠: {agenda.snoozedLabel}</span>
      <Button variant="outline" size="sm" onClick={onUnsnooze}>미루기 해제</Button>
    </>;
    secondary = undoButton;
  } else if (openQuestion && choiceQuestion) {
    primary = choiceQuestion.options.map((option) => <Button key={option.label} variant="choice" size="sm" className="pas-rt1707-choice"
      onClick={() => onChooseQuestion(option.label)}><span>{option.label}</span>
      {option.recommended ? <Badge variant="info" size="sm">권함</Badge> : null}</Button>);
    secondary = <>
      <CardQuestionActions view={questionView(choiceQuestion, null, true)} composerVisible={false}
        onAnswerFreely={() => openComposer("answer", document.activeElement as HTMLElement | null)}
        onAskBack={() => openComposer("ask", document.activeElement as HTMLElement | null)} />
      {snoozeButton}{undoButton}
    </>;
  } else if (choiceQuestion && questionAnswer !== null) {
    primary = <span className="pas-rt1707-answer-line">받은 답: <strong>{questionAnswer}</strong></span>;
    secondary = <>{commentButton}{undoButton}</>;
  } else {
    primary = <>
      {agenda.primary ? <Button variant="default" size="sm" disabled={settled || agenda.status === "running"} onClick={() => onDispose(agenda.primary!.id)}>{agenda.primary.label}</Button> : null}
      {agenda.secondary ? <Button variant="outline" size="sm" disabled={settled || agenda.status === "running"} onClick={() => onDispose(agenda.secondary!.id)}>{agenda.secondary.label}</Button> : null}
      {agenda.number === 1730 ? <Button variant="outline" size="sm" data-testid="pas-rt1707-simulate-event" onClick={onSimulate}>다음 경과 도착 시연</Button> : null}
      {settled && !undoLabel ? <span className="pas-rt1707-stamps-empty">처분 완료</span> : null}
    </>;
    secondary = <>{commentButton}{snoozeButton}{undoButton}</>;
  }
  return <footer ref={footerRef} className="pas-rt1707-decide" aria-label="결재 상자" onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    if (snoozeOpen) { event.preventDefault(); event.stopPropagation(); setSnoozeOpen(false); return; }
    if (composerOpen && (event.target as HTMLElement).closest(".pas-rt1707-composer-drawer")) { event.preventDefault(); event.stopPropagation(); closeComposer(); }
  }}>
    <div className="pas-rt1707-decide-actions">
      <div className="pas-rt1707-stamps">
        <div className="pas-rt1707-stamps-primary">{primary}</div>
        <div className="pas-rt1707-stamps-secondary">{secondary}</div>
        {snoozeOpen && !agenda.snoozedLabel ? <div className="pas-rt1707-snooze-options" aria-label="미룰 시간">
          {["1시간 뒤", "오늘 저녁", "내일 아침", "사흘 뒤"].map((label) => <Button key={label} variant="outline" size="sm" onClick={() => { setSnoozeOpen(false); onSnooze(label); }}>{label}</Button>)}
        </div> : null}
      </div>
    </div>
    {composerOpen ? <div className="pas-rt1707-composer-drawer">
      <CardQuestionNotice label={noticeLabel} onClear={closeComposer} />
      <CardComposer embedded text={text} onChangeText={onChangeText} onSend={send} placeholder={placeholder} label={sendLabel}
        disabled={text.trim().length === 0} pending={false} files={[]} onRemoveFile={() => undefined} focusRequest={focusRequest} />
    </div> : null}
  </footer>;
}
