import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Badge, Button } from "@seosoyoung/soul-ui";
import { CARD_COMPLETION_UNDO_MS } from "../../../../packages/wire-schema/src/persistent_report";
import { CardCommentInput } from "../CardCommentInput";
import { CardQuestionActions, CardQuestionNotice, cardQuestionDetailView } from "../CardQuestionBlock";
import { UndoCountdownRing } from "../UndoCountdownRing";
import { formatReturnTime, snoozeOptions, type Agenda } from "./pas-report-thread-model";
import type { PasReportThreadController, SendMode } from "./use-pas-report-thread";

type ComposerMode = "closed" | SendMode;

/**
 * 스레드 맨 아래 결재 상자. 평소에는 단추 줄만 보이고, 입력이 필요한 단추를 누를 때만 그 아래에 입력창이 열린다.
 * 입력창을 닫으면 초점은 그것을 연 단추로 돌아간다.
 */
export function PasThreadDecideBox({ controller, agenda, undoButtonRef, onLayoutChange }: {
  controller: PasReportThreadController;
  agenda: Agenda | null;
  undoButtonRef: RefObject<HTMLButtonElement | null>;
  /** 입력창이 열리고 닫히면 스레드 높이가 바뀐다. 바닥을 지키게 알린다. */
  onLayoutChange(): void;
}) {
  const { question, detail, target, busy, undo, snoozed, now } = controller;
  const [mode, setMode] = useState<ComposerMode>("closed");
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const triggerRef = useRef<HTMLElement | null>(null);
  const snoozeTriggerRef = useRef<HTMLButtonElement>(null);
  const settled = controller.processed.find(item => item.agenda.cardId === agenda?.cardId) ?? null;
  const questionOpen = question !== null;
  // 질문이 열려 있는 동안 창의 글은 모두 질문 글타래에 붙는다. 그래서 일반 지시 적기 단추는 두지 않는다.
  const composerMode: ComposerMode = target && mode === "closed" ? "comment" : mode;
  const composerOpen = composerMode !== "closed";
  useLayoutEffect(() => { onLayoutChange(); }, [composerOpen, snoozeOpen, onLayoutChange]);
  useEffect(() => {
    // 스레드의 「항목 지시」가 대상을 만들면 입력창을 열고, 누른 단추를 돌아갈 자리로 둔다.
    if (!target) return;
    triggerRef.current = target.trigger;
    setFocusRequest(value => value + 1);
  }, [target]);
  useEffect(() => { setMode("closed"); setSnoozeOpen(false); }, [agenda?.cardId]);

  const open = (next: SendMode, trigger: HTMLElement | null) => {
    triggerRef.current = trigger;
    setSnoozeOpen(false);
    setMode(next);
    setFocusRequest(value => value + 1);
  };
  const closeComposer = () => {
    // 입력창이 사라지기 전에 초점을 옮겨야 대화상자가 초점을 창 머리로 되돌리지 않는다.
    const trigger = triggerRef.current;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    triggerRef.current = null;
    if (target) controller.setTarget(null);
    setMode("closed");
  };
  const submit = async (body: string) => {
    if (!agenda) return false;
    const sent = await controller.send(agenda, body, composerMode === "closed" ? "comment" : composerMode);
    if (sent) {
      const trigger = triggerRef.current;
      triggerRef.current = null;
      setMode("closed");
      // 전송 중에는 단추가 꺼져 있으므로, 다시 켜진 뒤 연 단추로 초점을 돌린다.
      requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
    }
    return sent;
  };
  const view = question ? cardQuestionDetailView(question, detail?.comments ?? [], "") : null;
  const label = composerMode === "ask" ? "되묻기" : composerMode === "answer" ? "다르게 답하기" : "커멘트";
  const placeholder = composerMode === "ask" ? "물어볼 것" : composerMode === "answer" ? "다르게 답하기" : "커멘트";

  const undoRow = undo ? <div className="pas-rt-undo">
    <span className="pas-rt-undo-label">{undo.label}</span>
    <Button ref={undoButtonRef} variant="ghost" size="xs" disabled={busy || controller.completionBusy} onClick={() => void undo.run()}>
      <UndoCountdownRing key={`${undo.kind}-${undo.cardId}-${undo.expiresAt}`} expiresAt={undo.expiresAt} durationMs={CARD_COMPLETION_UNDO_MS} />되돌리기
    </Button>
  </div> : null;

  const canSnooze = agenda !== null && agenda.kind !== "running" && agenda.kind !== "verifying";
  // 미뤄 둔 안건은 그 종류의 단추 그대로, 답변 미루기 자리만 미루기 해제로 바뀐다.
  const snoozeSlot = !agenda || !canSnooze ? null : snoozed
    ? <Button variant="outline" disabled={busy} data-testid="pas-rt-unsnooze" onClick={() => void controller.unsnooze(agenda)}>미루기 해제</Button>
    : <Button ref={snoozeTriggerRef} variant="outline" disabled={busy} aria-expanded={snoozeOpen} data-testid="pas-rt-snooze-trigger"
      onClick={() => setSnoozeOpen(value => !value)}>답변 미루기</Button>;
  const commentButton = <Button variant="outline" disabled={busy} data-testid="pas-rt-open-composer"
    onClick={event => open("comment", event.currentTarget)}>지시 적기</Button>;
  const hint = snoozed && agenda ? <span className="pas-rt-hint">미뤄 둠: {formatReturnTime(agenda.snoozedUntil!, now)}</span> : null;

  let primary: React.ReactNode = null;
  let secondary: React.ReactNode = null;
  if (!agenda) {
    primary = null;
  } else if (settled) {
    primary = <span className="pas-rt-settled">{settled.label}</span>;
  } else if (questionOpen && view && question) {
    const isRequest = view.kind === "request";
    primary = <>{hint}{isRequest ? null : view.options.map(option => <Button key={option.label} variant="outline" className="pas-rt-choice" disabled={busy}
      onClick={() => void controller.choose(agenda, option.label)}><span>{option.label}</span>
      {option.recommended ? <Badge variant="info" size="sm">권함</Badge> : null}</Button>)}</>;
    secondary = <>
      <CardQuestionActions view={view} pending={busy} composerVisible={isRequest}
        onAnswerFreely={() => open("answer", document.activeElement as HTMLElement | null)}
        onAskBack={() => open("ask", document.activeElement as HTMLElement | null)}
        onDone={() => void controller.choose(agenda, "했어")} />
      {snoozeSlot}
    </>;
  } else if ((agenda.kind === "question" || agenda.kind === "request") && !detail) {
    // 카드 상세를 기다리는 동안은 질문의 선택지를 알 수 없다.
    primary = hint;
    secondary = snoozeSlot;
  } else if (agenda.kind === "review") {
    primary = <>{hint}
      <Button variant="default" disabled={busy || controller.completionBusy || !agenda.entry} onClick={() => void controller.complete(agenda, "done")}>완료</Button>
      <Button variant="outline" disabled={busy || controller.completionBusy || !agenda.entry} onClick={() => void controller.complete(agenda, "on_hold")}>보류</Button>
    </>;
    secondary = <>{commentButton}{snoozeSlot}</>;
  } else if (agenda.kind === "blocked") {
    primary = <>{hint}<Button variant="default" disabled={busy || !agenda.entry} onClick={() => void controller.acknowledge(agenda)}>확인했어</Button></>;
    secondary = <>{commentButton}{snoozeSlot}</>;
  } else {
    secondary = <>{commentButton}{snoozeSlot}</>;
  }
  const options = snoozeOpen ? snoozeOptions(new Date()) : [];
  return <footer className="pas-rt-decide" aria-label="결재 상자" data-testid="pas-rt-decide" onKeyDown={event => {
    if (event.key !== "Escape") return;
    if (snoozeOpen) { event.preventDefault(); event.stopPropagation(); setSnoozeOpen(false); snoozeTriggerRef.current?.focus({ preventScroll: true }); return; }
    if (composerOpen && (event.target as HTMLElement).closest(".pas-rt-composer-drawer")) { event.preventDefault(); event.stopPropagation(); closeComposer(); }
  }}>
    <div className="pas-rt-stamps">
      {primary ? <div className="pas-rt-stamps-primary">{primary}</div> : null}
      {secondary ? <div className="pas-rt-stamps-secondary">{secondary}</div> : null}
      {options.length ? <div className="pas-rt-snooze-options" role="group" aria-label="미룰 시간">
        {options.map(option => <Button key={option.id} variant="outline" disabled={busy} data-snooze-option={option.id}
          onClick={() => { setSnoozeOpen(false); if (agenda) void controller.snooze(agenda, option); }}>{option.label}</Button>)}
      </div> : null}
    </div>
    {undoRow}
    {controller.actionError ? <p role="alert" className="v3-card-error pas-rt-error">{controller.actionError}</p> : null}
    {composerOpen && agenda ? <div className="pas-rt-composer-drawer">
      {target ? <CardQuestionNotice label={`대상: ${target.itemId}번 항목`} onClear={closeComposer} />
        : <CardQuestionNotice label={label} onClear={closeComposer} />}
      <CardCommentInput cardId={`pas-thread:${agenda.cardId}:${composerMode}`} nodeId={null} sessionId={null} pending={busy}
        focusRequest={focusRequest} placeholder={placeholder} onSend={submit} />
    </div> : null}
  </footer>;
}
