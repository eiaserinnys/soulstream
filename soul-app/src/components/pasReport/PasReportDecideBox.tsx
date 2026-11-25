// 카드 #1871: 스레드 맨 아래 결재 상자. 평소에는 단추 줄만 보이고, 입력이 필요한 단추를 누를 때만 그 아래에 입력창이 열린다.
// 채운 주 단추나 선택지가 늘 왼쪽 묶음 첫 자리, 되묻기와 답변 미루기는 오른쪽 묶음이다. 좁은 폭에서 감겨도 같은 순서다.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { restoreAttachmentFocus } from '../../lib/attachment-focus';
import { snoozeOptions, type SendMode } from '../../../../packages/soul-ui/src/lib/pas-report-thread-core';
import { formatReturnTime } from '../../lib/pas-report-thread-model';
import { cardQuestionViewFromDetail } from '../planner/card-question-viewmodel';
import { useSessionStore } from '../../store/sessionStore';
import { createPrimitiveRoles, useTokens, type DesignTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { PersistentReportUndoRow } from '../persistent/PersistentReportSheet';
import { reportStyles } from '../persistent/persistentReportStyles';
import { CardCommentComposer, CardComposerNotice, type CardCommentComposerHandle } from '../planner/CardCommentComposer';
import { cardQuestionPlaceholder } from '../planner/CardQuestionBlock';
import type { PasReportWindowController } from './usePasReportWindow';

export type ComposerMode = 'closed' | SendMode;
/** 서랍, 답변 미루기 펼침, 입력창은 창이 쥔다. 뒤로 가기가 열린 것 하나씩 닫으려면 한 곳에서 알아야 한다. */
export interface DecideUi {
  mode: ComposerMode; setMode(mode: ComposerMode): void;
  snoozeOpen: boolean; setSnoozeOpen(open: boolean): void;
  /** 입력창을 연 단추(지시 적기, 되묻기, 다르게 답하기, 고칠 점 남기기). 입력창을 닫으면 접근성 초점이 여기로 돌아간다. */
  trigger: { current: unknown };
  /** 항목 대상을 풀고 입력창을 닫아, 연 단추에 초점을 돌려놓는다. 적던 글은 남는다. */
  closeComposer(): void;
}
export function useDecideUi(resetKey: string | null, releaseTarget: () => void): DecideUi {
  const [mode, setMode] = useState<ComposerMode>('closed');
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const trigger = useRef<unknown>(null);
  useEffect(() => { setMode('closed'); setSnoozeOpen(false); trigger.current = null; }, [resetKey]);
  const closeComposer = () => {
    releaseTarget();
    setMode('closed');
    const target = trigger.current;
    trigger.current = null;
    if (target) restoreAttachmentFocus(target);
  };
  return { mode, setMode, snoozeOpen, setSnoozeOpen, trigger, closeComposer };
}

export function PasReportDecideBox({ controller, ui }: { controller: PasReportWindowController; ui: DecideUi }) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const rs = useMemo(() => reportStyles(t, t.foundation.pageInset, false), [t]);
  const { active: agenda, question, detail, busy, undo, snoozed, now, targetItemId } = controller;
  const { mode, snoozeOpen } = ui;
  const composerRef = useRef<CardCommentComposerHandle>(null);
  const commentRef = useRef<View>(null);
  const askRef = useRef<View>(null);
  const answerRef = useRef<View>(null);
  const settled = controller.processed.find(item => item.agenda.cardId === agenda?.cardId) ?? null;
  const card = detail?.card;
  const catalogSession = useSessionStore(state => card?.assigneeSessionId ? state.sessions[card.assigneeSessionId] : undefined);
  const assigned = catalogSession ?? detail?.sessions.find(session => session.agentSessionId === card?.assigneeSessionId);
  const nodeId = assigned?.nodeId ?? card?.nodeId;
  const targetItem = detail?.card.items?.find(item => item.id === targetItemId) ?? null;
  // 항목 지시가 대상을 잡으면 입력창을 열고 대상을 이어받는다. 되묻기나 다르게 답하기가 열려 있었으면 항목 지시가 입력창을 이어받는다.
  const composerMode: ComposerMode = targetItem && mode !== 'comment' ? 'comment' : mode;
  const composerOpen = composerMode !== 'closed';
  const targetStamp = targetItem?.id ?? null;
  useEffect(() => {
    if (targetStamp === null) return;
    if (controller.targetTrigger.current) ui.trigger.current = controller.targetTrigger.current;
    ui.setMode('comment');
    ui.setSnoozeOpen(false);
  }, [targetStamp]);
  useEffect(() => {
    if (!composerOpen) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [composerOpen, composerMode]);

  const open = (next: SendMode, from: React.RefObject<View | null>) => {
    // 카드 상세가 없으면 입력창을 열 수 없다. 보이지 않는 입력창 상태만 남지 않게 아무것도 바꾸지 않는다.
    if (!card) return;
    // 항목 대상이 잡힌 채 되묻기나 다르게 답하기를 열면 대상을 푼다. 그 글은 항목 지시가 아니다.
    if (next !== 'comment' && targetItem) controller.setTargetItem(null);
    ui.setSnoozeOpen(false);
    ui.trigger.current = from.current;
    ui.setMode(next);
  };
  const button = (label: string, onPress: () => void, options: { primary?: boolean; disabled?: boolean; testID?: string; expanded?: boolean; note?: string; ref?: React.RefObject<View | null> } = {}) =>
    <GlassButton key={label} testID={options.testID} buttonRef={options.ref} contentStyle={options.primary ? undefined : styles.paperFrame} variant={options.primary ? 'primary' : 'paper'} size="compact" busy={options.disabled}
      accessibilityLabel={label} accessibilityState={options.expanded === undefined ? undefined : { expanded: options.expanded }}
      onPress={() => { if (!options.disabled) onPress(); }} style={styles.button}>
      <Text style={[styles.buttonLabel, options.primary && { color: t.colors.accentText }]}>{label}{options.note ? <Text style={styles.recommended}>{`  ${options.note}`}</Text> : null}</Text>
    </GlassButton>;

  const hint = snoozed && agenda?.snoozedUntil != null
    ? <Text key="hint" style={styles.hint} numberOfLines={1}>미뤄 둠: {formatReturnTime(agenda.snoozedUntil, now)}</Text> : null;
  const commentButton = button('지시 적기', () => open('comment', commentRef), { disabled: busy || !card, testID: 'pas-report-open-composer', ref: commentRef });
  const canSnooze = agenda !== null && agenda.kind !== 'running' && agenda.kind !== 'verifying';
  // 미뤄 둔 안건은 그 종류의 단추 그대로, 답변 미루기 자리만 미루기 해제로 바뀐다. 진행 중과 검증 대기도 미뤄 둔 것이면 해제를 둔다.
  const snoozeSlot = !agenda || (!canSnooze && !snoozed) ? null : snoozed
    ? button('미루기 해제', () => { void controller.unsnooze(agenda); }, { disabled: busy, testID: 'pas-report-unsnooze' })
    : button('답변 미루기', () => { ui.setMode('closed'); ui.setSnoozeOpen(!snoozeOpen); }, { disabled: busy, testID: 'pas-report-snooze-trigger', expanded: snoozeOpen });

  let primary: React.ReactNode = null;
  let secondary: React.ReactNode = null;
  if (!agenda) {
    primary = null;
  } else if (settled) {
    primary = <Text style={styles.hint}>{settled.label}</Text>;
  } else if (question) {
    const view = cardQuestionViewFromDetail(question, detail?.comments ?? [], '');
    const request = view.kind === 'request';
    primary = <>{request
      ? button('했어', () => { void controller.choose(agenda, '했어'); }, { primary: true, disabled: busy, testID: 'pas-report-done' })
      : view.options.map(option => button(option.label, () => { void controller.choose(agenda, option.label); },
        { disabled: busy, note: option.recommended ? '권함' : undefined }))}{hint}</>;
    secondary = <>
      {request ? null : button('다르게 답하기', () => open('answer', answerRef), { disabled: busy, testID: 'pas-report-answer-freely', ref: answerRef })}
      {button('되묻기', () => open('ask', askRef), { disabled: busy, testID: 'pas-report-ask-back', ref: askRef })}
      {snoozeSlot}
    </>;
  } else if ((agenda.kind === 'question' || agenda.kind === 'request') && !detail) {
    // 카드 상세를 기다리는 동안은 질문의 선택지를 알 수 없다.
    primary = hint;
    secondary = snoozeSlot;
  } else if (agenda.kind === 'review') {
    const disabled = busy || controller.completionBusy || !agenda.entry;
    primary = <>
      {button('완료', () => { void controller.complete(agenda, 'done'); }, { primary: true, disabled, testID: 'pas-report-complete' })}
      {button('보류', () => { void controller.complete(agenda, 'on_hold'); }, { disabled, testID: 'pas-report-hold' })}{hint}
    </>;
    secondary = <>{commentButton}{snoozeSlot}</>;
  } else if (agenda.kind === 'blocked') {
    primary = <>{button('확인했어', () => { void controller.acknowledge(agenda); }, { primary: true, disabled: busy || !agenda.entry, testID: 'pas-report-acknowledge' })}{hint}</>;
    secondary = <>{commentButton}{snoozeSlot}</>;
  } else {
    primary = hint;
    secondary = <>{commentButton}{snoozeSlot}</>;
  }

  const undoRow = undo ? <PersistentReportUndoRow styles={rs}
    undo={{ label: undo.label, expiresAt: undo.expiresAt, busy: busy || controller.completionBusy, onUndo: () => { void undo.run(); } }} /> : null;
  // 안건이 없으면 결재 상자 자리도 없다. 되돌리기 줄이나 실패 안내가 남아 있을 때만 선다.
  if (!agenda && !undoRow && !controller.actionError) return null;
  const options = snoozeOpen ? snoozeOptions(new Date()) : [];
  const openQuestion = mode === 'ask' && question ? { kind: 'ask' as const, questionId: question.id } : null;
  return <View testID="pas-report-decide" accessibilityLabel="결재 상자" style={styles.box}>
    <View style={styles.stamps}>
      {primary ? <View testID="pas-report-stamps-primary" style={styles.group}>{primary}</View> : null}
      {secondary ? <View testID="pas-report-stamps-secondary" style={[styles.group, styles.groupEnd]}>{secondary}</View> : null}
    </View>
    {options.length ? <View testID="pas-report-snooze-options" accessibilityLabel="미룰 시간" style={styles.group}>
      {options.map(option => button(option.label, () => { ui.setSnoozeOpen(false); if (agenda) void controller.snooze(agenda, option); },
        { disabled: busy, testID: `pas-report-snooze-${option.id}` }))}
    </View> : null}
    {undoRow}
    {controller.actionError ? <Text testID="pas-report-action-error" accessibilityRole="alert" selectable style={styles.error}>{controller.actionError}</Text> : null}
    {composerOpen && agenda && card ? <View testID="pas-report-composer" style={styles.composer}>
      {composerMode === 'comment' && !targetItem ? <CardComposerNotice testID="pas-report-composer-notice" text="커멘트" releaseLabel="해제" onRelease={ui.closeComposer} /> : null}
      {composerMode === 'answer' ? <CardComposerNotice testID="pas-report-composer-notice" text="다르게 답하기" releaseLabel="해제" onRelease={ui.closeComposer} /> : null}
      <CardCommentComposer key={`${card.id}:${composerMode}`} ref={composerRef} api={controller.api} cardId={card.id}
        sessionId={card.assigneeSessionId} nodeId={nodeId} question={composerMode === 'answer' ? question ?? undefined : undefined}
        cardLoaded locked={busy} sending={controller.commentsPending || busy} onBusyChange={() => {}}
        sendComment={controller.sendComment} runMutation={controller.runMutation} embedded
        targetItem={composerMode === 'comment' ? targetItem : null} questionTarget={composerMode === 'ask' ? openQuestion : null}
        onReleaseQuestionTarget={ui.closeComposer} onReleaseTarget={ui.closeComposer} onTargetSent={() => controller.setTargetItem(null)}
        placeholder={composerMode === 'comment' ? '커멘트' : cardQuestionPlaceholder(openQuestion, composerMode === 'answer')}
        onSent={() => { if (composerMode === 'answer') controller.answeredByText(agenda); ui.closeComposer(); }} />
    </View> : null}
  </View>;
}

function makeStyles(t: DesignTokens) {
  const type = t.foundation.typography;
  return StyleSheet.create({
    box: { gap: t.uiSpacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.persistentSession.line,
      backgroundColor: t.persistentSession.panel, paddingHorizontal: t.uiSpacing.lg, paddingTop: t.uiSpacing.md, paddingBottom: t.uiSpacing.lg },
    stamps: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: t.uiSpacing.md, rowGap: t.uiSpacing.sm },
    group: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: t.uiSpacing.sm, rowGap: t.uiSpacing.xs, minWidth: 0, flexShrink: 1 },
    groupEnd: { marginLeft: 'auto', justifyContent: 'flex-end' },
    button: { maxWidth: '100%' },
    // 채운 단추는 최소 높이가 더 크고(2pt 유리 테두리 포함) 테두리 단추는 바깥 가는 테두리를 따로 두어 한 줄에서 어긋난다.
    // 같은 줄 단추는 같은 높이여야 하므로 테두리 단추의 안쪽 높이를 채운 단추의 높이에서 바깥 테두리만큼 뺀 값으로 맞춘다.
    paperFrame: { minHeight: Math.max(t.hitTarget.min, createPrimitiveRoles(t).buttonPrimary.minHeight) - 2 * StyleSheet.hairlineWidth },
    buttonLabel: { ...type.body, color: t.colors.textPrimary },
    recommended: { ...type.label, color: t.colors.accent },
    hint: { ...type.meta, color: t.colors.textSecondary, flexShrink: 1 },
    error: { ...type.meta, color: t.colors.statusError },
    composer: { gap: t.uiSpacing.xs },
  });
}
