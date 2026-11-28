import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from 'react';
import type { PersistentReportEntry } from '../../../packages/wire-schema/src/persistent_report';
import { Button, FrameLoading, StatusChip, useAgentPortraitUrlResolver, useAuth, useDashboardStore, useInternalLinkClick } from '@seosoyoung/soul-ui';
import { cardMutationKey, cardQuestionChoiceAnswer, cardQuestionTextAnswer } from '@seosoyoung/soul-ui/cards/card-api';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import { CardCheckItems } from './CardCheckItems';
import { CardCommentInput } from './CardCommentInput';
import { CardNowPanel } from './CardNowPanel';
import { CardTimeline } from './CardTimeline';
import { summarizeCardItems } from './card-item-summary';
import { CardQuestionActions, CardQuestionAnswered, CardQuestionBody, CardQuestionNotice, cardQuestionDetailView, cardQuestionSheetView, isOpenCardQuestion, type CardQuestionView } from './CardQuestionBlock';
import { cardQuestionTargetGeneration, clearCardQuestionTarget, pasSheetTargetScope, setCardQuestionTarget, useCardQuestionTarget, type CardQuestionTarget } from './card-question-target';
import type { ReportQuestionControls, ReportQuestionView } from './PersistentReportDeck';

type PasCardEntry = PersistentReportEntry & { card_id?: string; card_status?: string };
type Props = {
  entry: PasCardEntry;
  lookupCards: () => Promise<void>;
  samplePortraitUrl?: string;
};
const EMPTY_PENDING_CONFIRMATIONS: Readonly<Record<number, boolean>> = {};

export function PasCardExpansion({ entry, lookupCards, samplePortraitUrl }: Props) {
  const { t } = useTranslation();
  const byId = useCardStore(state => state.byId);
  const catalog = useDashboardStore(state => state.catalog);
  const { user } = useAuth();
  const internalLinkClick = useInternalLinkClick();
  const cardNumber = entry.card_numbers.length === 1 ? entry.card_numbers[0] : null;
  const cardId = entry.card_id ?? Object.values(byId).find(card => card.number === cardNumber)?.id;
  const storedCard = useCardStore(state => cardId ? state.byId[cardId] : undefined);
  const storedDetail = useCardStore(state => cardId ? state.details[cardId] : undefined);
  const error = useCardStore(state => cardId ? state.errors[cardId] : undefined);
  const pendingConfirmations = useCardStore(state => cardId ? state.pendingItemConfirmations[cardId] ?? EMPTY_PENDING_CONFIRMATIONS : EMPTY_PENDING_CONFIRMATIONS);
  const [targetItemId, setTargetItemId] = useState<number | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [pending, setPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const questionScope = pasSheetTargetScope(entry.key);
  const questionTarget = useCardQuestionTarget(questionScope);
  const validTarget = questionTarget.target && (!storedDetail || storedDetail.questions.some(question => question.id === questionTarget.target!.questionId)) ? questionTarget.target : null;
  const lastSendError = useRef<string | null>(null);
  const card = storedCard;
  const detail = storedDetail;
  const assignee = catalog?.sessionList?.find(session => session.agentSessionId === card?.assigneeSessionId)
    ?? detail?.sessions.find(session => session.sessionId === card?.assigneeSessionId);
  const portraitAgentId = assignee?.agentId ?? card?.assigneeAgentId;
  const resolvePortrait = useAgentPortraitUrlResolver();
  const portraitUrl = samplePortraitUrl ?? resolvePortrait(portraitAgentId);

  useEffect(() => {
    if (entry.card_id || cardId || cardNumber === null) return;
    void lookupCards();
  }, [cardId, cardNumber, entry.card_id, lookupCards]);
  useEffect(() => {
    if (!cardId) return;
    void useCardStore.getState().loadCard(cardId).catch(() => undefined);
  }, [cardId]);
  // 되묻기·덧붙이기 대상은 이 펼친 장이 살아 있는 동안만 산다. StrictMode의 모의 재마운트는
  // cleanup과 effect를 같은 커밋에서 이어 돌리므로, 다음 마이크로태스크에 아직 내려갔을 때만 지운다.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current) clearCardQuestionTarget(questionScope);
      });
    };
  }, [questionScope]);
  useEffect(() => {
    if (questionTarget.target && storedDetail && !storedDetail.questions.some(question => question.id === questionTarget.target!.questionId)) clearCardQuestionTarget(questionScope);
  }, [questionScope, questionTarget.target, storedDetail]);

  // Store mutations also publish errors; their local alert owns those messages.
  const errorAlert = error && error !== lastSendError.current ? <p role="alert" className="v3-card-error">{error}</p> : null;
  if (!card) return errorAlert ?? <FrameLoading label={t("persistent.expansion.loading")} />;

  const questions = detail?.questions ?? [];
  const question = (entry.question_id ? questions.find(item => item.id === entry.question_id && isOpenCardQuestion(item)) : undefined)
    ?? questions.find(isOpenCardQuestion);
  const items = card.items ?? [];
  const targetItemRow = targetItemId === null ? undefined : items.find(item => item.id === targetItemId);
  const summary = summarizeCardItems(items, pendingConfirmations);
  const recentComments = [...(detail?.comments ?? [])]
    .filter(comment => comment.kind !== 'note')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-2);
  const commentsDetail = detail ? { ...detail, comments: recentComments } : undefined;

  const confirmItem = async (itemId: number, confirmed: boolean) => {
    if (cardId) await useCardStore.getState().confirmItem(cardId, itemId, confirmed);
  };
  const targetItem = (itemId: number) => {
    setTargetItemId(itemId);
    setFocusRequest(request => request + 1);
  };
  const clearQuestionTarget = () => {
    setFocusRequest(request => request + questionTarget.focus + 1);
    clearCardQuestionTarget(questionScope);
  };
  const send = async (body: string) => {
    if (!body.trim() || pending) return false;
    setPending(true);
    try {
      if (cardId && targetItemId !== null) {
        await useCardStore.getState().addComment(cardId, body.trim(), cardMutationKey(), targetItemId);
      } else if (cardId && validTarget) {
        await useCardStore.getState().addComment(cardId, body.trim(), cardMutationKey(), undefined, validTarget.questionId);
      } else if (cardId && question) {
        await useCardStore.getState().mutate(cardId, `/questions/${encodeURIComponent(question.id)}/answer`, cardQuestionTextAnswer(body.trim()));
      } else if (cardId) {
        await useCardStore.getState().addComment(cardId, body.trim(), cardMutationKey());
      }
      setTargetItemId(null);
      clearCardQuestionTarget(questionScope);
      setSendError(null);
      lastSendError.current = null;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastSendError.current = message;
      setSendError(message);
      return false;
    } finally {
      setPending(false);
    }
  };

  return <div className="pas-report-card-preview" data-testid="pas-card-expansion">
    <CardNowPanel embedded hideTurn={Boolean(question)} now={card.now} itemsCount={items.length} activeCount={summary.activeCount} />
    {errorAlert}
    <CardCheckItems items={items} pendingConfirmations={pendingConfirmations} onConfirmChange={confirmItem} onTargetItem={targetItem} />
    <CardTimeline card={card} detail={commentsDetail} portraitUrl={portraitUrl} userPortraitUrl={user?.picture ?? ''} commentsOnly pending={pending} onAnswer={() => {}} />
    {cardId ? <Button variant="link" className="text-foreground" render={<a href={`/?card=${encodeURIComponent(cardId)}`} onClick={internalLinkClick} />}>{t("persistent.expansion.openCard")}</Button> : null}
    {targetItemId !== null ? <div className="v3-card-target-notice" role="status"><span>{t("persistent.expansion.itemTarget", { number: targetItemId, title: targetItemRow?.title ?? t("persistent.expansion.item") })}</span><button type="button" aria-label={t("persistent.expansion.clearCommentTarget")} onClick={() => { setTargetItemId(null); setFocusRequest(request => request + 1); }}>{t("persistent.expansion.clear")}</button></div> : null}
    {targetItemId === null && validTarget ? <CardQuestionNotice label={validTarget.kind === 'ask' ? t("persistent.thread.askBack") : t("persistent.expansion.appendTo", { answer: validTarget.label })} onClear={clearQuestionTarget} /> : null}
    {sendError ? <p role="alert" className="v3-card-error">{sendError}</p> : null}
    <CardCommentInput cardId={cardId ?? entry.key} nodeId={card.nodeId} sessionId={card.assigneeSessionId} pending={pending} focusRequest={focusRequest + questionTarget.focus}
      kind={targetItemId === null && (validTarget || question) ? "answer" : "comment"} placeholder={targetItemId !== null ? t("persistent.thread.comment") : validTarget?.kind === 'ask' ? t("persistent.thread.askPlaceholder") : validTarget?.kind === 'append' ? t("persistent.expansion.appendPlaceholder") : question ? t("persistent.thread.answerFreely") : t("persistent.thread.comment")} onSend={send} />
  </div>;
}

/** PAS 판 질문 장: 접힌 장의 선택은 기존 판 답 경로, 펼친 장의 선택은 카드 답 경로를 쓴다. */
export function pasCardQuestion(entry: PersistentReportEntry, controls: ReportQuestionControls): ReportQuestionView | null {
  // 질문 장이 아닌 보고 장은 기존 판 그대로 그린다. 판 항목 키가 cq_인 것만 질문이다.
  if (!entry.key.startsWith('cq_')) return null;
  const view = cardQuestionSheetView(controls.answer === undefined ? entry : { ...entry, state: 'answered', answer: controls.answer });
  const scope = pasSheetTargetScope(entry.key);
  const cardId = (entry as PasCardEntry).card_id;
  const choose = async (option: string) => {
    if (!controls.expanded) return controls.reply(option);
    if (!cardId) return false;
    // 보내기 시작과 함께 잠정으로 붙들고, 답 저장이 끝나면 확정한다.
    const generation = cardQuestionTargetGeneration(scope);
    controls.hold(option);
    try {
      await useCardStore.getState().mutate(cardId, `/questions/${encodeURIComponent(view.id)}/answer`, cardQuestionChoiceAnswer(option));
      const isRequestDone = option === '했어'; // i18n-ignore: 서버가 부여한 요청 완료 선택지와 비교한다.
      if (!isRequestDone && cardQuestionTargetGeneration(scope) === generation) setCardQuestionTarget(scope, { kind: 'append', questionId: view.id, label: option });
      controls.confirm();
      return true;
    } catch {
      controls.release();
      return false;
    }
  };
  return {
    meta: view.revisedAt ? <PasQuestionRevision revisedAt={view.revisedAt} /> : null,
    body: <PasQuestionBody entry={entry} answer={controls.answer} pending={controls.pending} onChoose={choose} />,
    actions: <PasQuestionActions entry={entry} answer={controls.answer} pending={controls.pending} expanded={controls.expanded} expand={controls.expand} onChoose={choose} />,
  };
}

function PasQuestionRevision({ revisedAt }: { revisedAt: string }) {
  const { t, i18n } = useTranslation();
  const time = new Date(revisedAt).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return <span className="v3-card-question-meta">{t("persistent.expansion.revisedAt", { time })}</span>;
}

/** 펼친 장의 질문 보기는 카드 상세에 실린 질문·답을 쓴다. 상세가 아직 없으면 판 항목으로 그린다. */
function usePasQuestionView(entry: PersistentReportEntry, answer: string | undefined): CardQuestionView {
  const cardId = (entry as PasCardEntry).card_id;
  const detail = useCardStore(state => cardId ? state.details[cardId] : undefined);
  const question = entry.question_id ? detail?.questions.find(item => item.id === entry.question_id) : undefined;
  const view = question ? cardQuestionDetailView(question, detail?.comments ?? [], '') : cardQuestionSheetView(answer === undefined ? entry : { ...entry, state: 'answered', answer });
  if (answer === undefined) return view;
  return { ...view, open: false, answer, selectedOption: view.options.find(option => option.label === answer)?.label ?? view.selectedOption };
}

function PasQuestionBody({ entry, answer, pending, onChoose }: { entry: PersistentReportEntry; answer: string | undefined; pending: boolean; onChoose(option: string): Promise<boolean> | boolean }) {
  const view = usePasQuestionView(entry, answer);
  const cardId = (entry as PasCardEntry).card_id;
  const { user } = useAuth();
  const card = useCardStore(state => cardId ? state.byId[cardId] : undefined);
  const catalog = useDashboardStore(state => state.catalog);
  const assignee = catalog?.sessionList?.find(session => session.agentSessionId === card?.assigneeSessionId);
  const agentId = assignee?.agentId ?? card?.assigneeAgentId;
  const resolvePortrait = useAgentPortraitUrlResolver();
  const portrait = resolvePortrait(agentId) || null;
  return <CardQuestionBody view={view} portraitUrl={portrait} userPortraitUrl={user?.picture ?? ''} pending={pending} onChoose={onChoose} />;
}

function PasQuestionActions({ entry, answer, pending, expanded, expand, onChoose }: {
  entry: PersistentReportEntry;
  answer: string | undefined;
  pending: boolean;
  expanded: boolean;
  expand(): void;
  onChoose(option: string): Promise<boolean> | boolean;
}) {
  const view = usePasQuestionView(entry, answer);
  const expandWith = (target: CardQuestionTarget | null) => { expand(); setCardQuestionTarget(pasSheetTargetScope(entry.key), target, true); };
  if (!view.open) return <CardQuestionAnswered view={view} onAppend={() => { if (view.answer) expandWith({ kind: 'append', questionId: view.id, label: view.answer }); }} />;
  return <CardQuestionActions view={view} pending={pending} composerVisible={expanded}
    onAnswerFreely={() => expandWith(null)}
    onAskBack={() => expandWith({ kind: 'ask', questionId: view.id })}
    onDone={() => {
      void onChoose('했어'); // i18n-ignore: 서버가 부여한 요청 완료 선택지를 전송한다.
    }} />;
}

export function PasCardExpansionStatus({ entry }: { entry: PasCardEntry }) {
  const { t } = useTranslation();
  if (entry.key.startsWith('cq_')) return <StatusChip label={entry.question_kind === 'request' ? t("persistent.expansion.cardRequest") : t("persistent.expansion.cardQuestion")} tone="question" />;
  if (!entry.card_status) return null;
  const status = t(`persistent.thread.status.${entry.card_status}`, { defaultValue: entry.card_status });
  return <StatusChip label={t("persistent.expansion.cardStatus", { status })} tone={entry.card_status} className={`v3-card-status--${entry.card_status}`} />;
}
