import { useTranslation } from "react-i18next";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Badge, Button, useDashboardStore } from "@seosoyoung/soul-ui";
import { CARD_COMPLETION_UNDO_MS } from "../../../../packages/wire-schema/src/persistent_report";
import { CardCommentInput } from "../CardCommentInput";
import { CardQuestionActions, CardQuestionNotice, cardQuestionDetailView } from "../CardQuestionBlock";
import { UndoCountdownRing } from "../UndoCountdownRing";
import { snoozeOptions, type SendMode } from "@seosoyoung/soul-ui/lib/pas-report-thread-core";
import { formatReturnTime, type Agenda } from "./pas-report-thread-model";
import type { PasReportThreadController } from "./use-pas-report-thread";

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
  const { t, i18n } = useTranslation();
  const { question, detail, target, busy, undo, snoozed, now } = controller;
  const [mode, setMode] = useState<ComposerMode>("closed");
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const triggerRef = useRef<HTMLElement | null>(null);
  const snoozeTriggerRef = useRef<HTMLButtonElement>(null);
  const commentButtonRef = useRef<HTMLButtonElement>(null);
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
    // 되묻기나 다르게 답하기가 열려 있었다면 항목 지시가 입력창을 이어받는다. 알림줄과 보내는 곳이 같아야 한다.
    setMode("comment");
    setSnoozeOpen(false);
    setFocusRequest(value => value + 1);
  }, [target]);
  useEffect(() => { setMode("closed"); setSnoozeOpen(false); }, [agenda?.cardId]);

  const open = (next: SendMode, trigger: HTMLElement | null) => {
    // 항목 대상이 잡힌 채 되묻기나 다르게 답하기를 열면 대상은 풀린다. 그 글은 항목 지시가 아니다.
    if (next !== "comment" && target) controller.setTarget(null);
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
  // 카드 패널의 커멘트 입력과 같은 규칙으로 담당 세션이 있는 카드에서 파일 첨부가 붙는다.
  const card = detail?.card;
  const assigneeSessionId = card?.assigneeSessionId ?? null;
  const assigneeNodeId = useDashboardStore(state => assigneeSessionId
    ? state.catalog?.sessionList?.find(session => session.agentSessionId === assigneeSessionId)?.nodeId : undefined);
  const attachNodeId = assigneeNodeId ?? detail?.sessions.find(session => session.sessionId === assigneeSessionId)?.nodeId ?? card?.nodeId ?? null;
  const view = question ? cardQuestionDetailView(question, detail?.comments ?? [], "") : null;
  const label = composerMode === "ask" ? t("persistent.thread.askBack") : composerMode === "answer" ? t("persistent.thread.answerFreely") : t("persistent.thread.comment");
  const placeholder = composerMode === "ask" ? t("persistent.thread.askPlaceholder") : composerMode === "answer" ? t("persistent.thread.answerFreely") : t("persistent.thread.comment");

  const undoRow = undo ? <div className="pas-rt-undo">
    <span className="pas-rt-undo-label">{undo.label}</span>
    <Button ref={undoButtonRef} variant="ghost" size="xs" disabled={busy || controller.completionBusy} onClick={() => void undo.run()}>
      <UndoCountdownRing key={`${undo.kind}-${undo.cardId}-${undo.expiresAt}`} expiresAt={undo.expiresAt} durationMs={CARD_COMPLETION_UNDO_MS} />{t("persistent.undo")}
    </Button>
  </div> : null;

  const canSnooze = agenda !== null && agenda.kind !== "running" && agenda.kind !== "verifying";
  // 미뤄 둔 안건은 그 종류의 단추 그대로, 답변 미루기 자리만 미루기 해제로 바뀐다.
  // 해제하면 누른 단추가 사라진다. 초점이 body로 떨어지지 않게, 화면이 해제된 모양으로 바뀐 직후 그 자리에 남는 단추
  // (답변 미루기, 없으면 지시 적기)로 준다. 서버 응답, 화면 갱신, 처리 끝의 앞뒤가 정해져 있지 않아 갱신을 지켜보는 쪽에서 옮긴다.
  const refocusAfterUnsnooze = useRef(false);
  useLayoutEffect(() => {
    // 처리 중에는 단추가 모두 비활성이라 초점을 받지 못한다. 끝난 뒤에 옮긴다.
    if (snoozed || busy || !refocusAfterUnsnooze.current) return;
    refocusAfterUnsnooze.current = false;
    const current = document.activeElement;
    if (current && current !== document.body && current.isConnected) return;
    (snoozeTriggerRef.current ?? commentButtonRef.current)?.focus({ preventScroll: true });
  }, [snoozed, busy]);
  const unsnoozeAndRefocus = async (target: Agenda) => {
    refocusAfterUnsnooze.current = true;
    const done = await controller.unsnooze(target);
    if (done) return;
    // 실패하면 해제 단추가 그대로 남아 있으니 거기로 돌려준다.
    refocusAfterUnsnooze.current = false;
    requestAnimationFrame(() => {
      const current = document.activeElement;
      if (current && current !== document.body && current.isConnected) return;
      document.querySelector<HTMLElement>('.pas-rt-decide [data-testid="pas-rt-unsnooze"]')?.focus({ preventScroll: true });
    });
  };
  const snoozeSlot = !agenda || (!canSnooze && !snoozed) ? null : snoozed
    ? <Button variant="outline" disabled={busy} data-testid="pas-rt-unsnooze" onClick={() => void unsnoozeAndRefocus(agenda)}>{t("persistent.thread.unsnooze")}</Button>
    : <Button ref={snoozeTriggerRef} variant="outline" disabled={busy} aria-expanded={snoozeOpen} data-testid="pas-rt-snooze-trigger"
      onClick={() => setSnoozeOpen(value => !value)}>{t("persistent.thread.snooze")}</Button>;
  const commentButton = <Button ref={commentButtonRef} variant="outline" disabled={busy} data-testid="pas-rt-open-composer"
    onClick={event => open("comment", event.currentTarget)}>{t("persistent.thread.instruct")}</Button>;
  const hint = snoozed && agenda ? <span className="pas-rt-hint">{t("persistent.thread.snoozedUntil", { time: formatReturnTime(agenda.snoozedUntil!, now, t, i18n.language) })}</span> : null;

  let primary: React.ReactNode = null;
  let secondary: React.ReactNode = null;
  if (!agenda) {
    primary = null;
  } else if (settled) {
    primary = <span className="pas-rt-settled">{settled.label}</span>;
  } else if (questionOpen && view && question) {
    const isRequest = view.kind === "request";
    // 채운 주 단추(부탁의 「했어」)나 선택지 알약이 왼쪽 묶음 첫 자리다. 되묻기와 미루기는 오른쪽 묶음이다.
    primary = <>{isRequest
      ? <Button variant="default" disabled={busy} data-testid="pas-rt-done" onClick={() => void controller.choose(agenda, "했어") // i18n-ignore: 요청 완료 답안은 서버가 부여한 선택지 값이다.
      }>{t("persistent.thread.didIt")}</Button>
      : view.options.map(option => <Button key={option.label} variant="outline" className="pas-rt-choice" disabled={busy}
        onClick={() => void controller.choose(agenda, option.label)}><span>{option.label}</span>
        {option.recommended ? <Badge variant="info" size="sm">{t("persistent.thread.recommended")}</Badge> : null}</Button>)}{hint}</>;
    secondary = <>
      <CardQuestionActions view={{ ...view, kind: "choice" }} pending={busy} composerVisible={isRequest}
        onAnswerFreely={() => open("answer", document.activeElement as HTMLElement | null)}
        onAskBack={() => open("ask", document.activeElement as HTMLElement | null)} />
      {snoozeSlot}
    </>;
  } else if ((agenda.kind === "question" || agenda.kind === "request") && !detail) {
    // 카드 상세를 기다리는 동안은 질문의 선택지를 알 수 없다.
    primary = hint;
    secondary = snoozeSlot;
  } else if (agenda.kind === "review") {
    primary = <>
      <Button variant="default" disabled={busy || controller.completionBusy || !agenda.entry} onClick={() => void controller.complete(agenda, "done")}>{t("persistent.thread.done")}</Button>
      <Button variant="outline" disabled={busy || controller.completionBusy || !agenda.entry} onClick={() => void controller.complete(agenda, "on_hold")}>{t("persistent.thread.hold")}</Button>
      {hint}
    </>;
    secondary = <>{commentButton}{snoozeSlot}</>;
  } else if (agenda.kind === "blocked") {
    primary = <><Button variant="default" disabled={busy || !agenda.entry} onClick={() => void controller.acknowledge(agenda)}>{t("persistent.thread.acknowledge")}</Button>{hint}</>;
    secondary = <>{commentButton}{snoozeSlot}</>;
  } else {
    // 진행 중과 검증 대기는 결재 단추가 없지만, 미뤄 둔 것이면 다른 종류와 같은 자리에 돌아올 시각을 보인다.
    primary = hint;
    secondary = <>{commentButton}{snoozeSlot}</>;
  }
  const options = snoozeOpen ? snoozeOptions(new Date()) : [];
  // 안건이 없으면 결재 상자 자리도 없다. 되돌리기 줄이나 실패 안내가 남아 있을 때만 서 있는다.
  if (!agenda && !undoRow && !controller.actionError) return null;
  return <footer className="pas-rt-decide" aria-label={t("persistent.thread.decisions")} data-testid="pas-rt-decide" onKeyDown={event => {
    if (event.key !== "Escape") return;
    if (snoozeOpen) { event.preventDefault(); event.stopPropagation(); setSnoozeOpen(false); snoozeTriggerRef.current?.focus({ preventScroll: true }); return; }
    if (composerOpen && (event.target as HTMLElement).closest(".pas-rt-composer-drawer")) { event.preventDefault(); event.stopPropagation(); closeComposer(); }
  }}>
    <div className="pas-rt-stamps">
      {primary ? <div className="pas-rt-stamps-primary">{primary}</div> : null}
      {secondary ? <div className="pas-rt-stamps-secondary">{secondary}</div> : null}
      {options.length ? <div className="pas-rt-snooze-options" role="group" aria-label={t("persistent.thread.snoozeDuration")}>
        {options.map(option => <Button key={option.id} variant="outline" disabled={busy} data-snooze-option={option.id}
          onClick={() => { setSnoozeOpen(false); if (agenda) void controller.snooze(agenda, option); }}>{t(`persistent.thread.snoozeOption.${option.id}`)}</Button>)}
      </div> : null}
    </div>
    {undoRow}
    {controller.actionError ? <p role="alert" className="v3-card-error pas-rt-error">{controller.actionError}</p> : null}
    {composerOpen && agenda ? <div className="pas-rt-composer-drawer">
      {target ? <CardQuestionNotice label={t("persistent.thread.itemTarget", { number: target.itemId })} onClear={closeComposer} />
        : <CardQuestionNotice label={label} onClear={closeComposer} />}
      <CardCommentInput cardId={`pas-thread:${agenda.cardId}:${composerMode}`} nodeId={attachNodeId} sessionId={assigneeSessionId} pending={busy}
        focusRequest={focusRequest} placeholder={placeholder} onSend={submit} />
    </div> : null}
  </footer>;
}
