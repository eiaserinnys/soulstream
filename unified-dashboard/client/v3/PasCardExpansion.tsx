import { useEffect, useState } from 'react';
import { Button, useAuth, useDashboardStore, useInternalLinkClick, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import { cardMutationKey } from '@seosoyoung/soul-ui/cards/card-api';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import type { CardComment, CardDetail, CardRow } from '@seosoyoung/soul-ui/cards/card-types';
import { CardCheckItems } from './CardCheckItems';
import { CardCommentInput } from './CardCommentInput';
import { CardStatusChip } from './CardActions';
import { CardNowPanel } from './CardNowPanel';
import { CardTimeline } from './CardTimeline';
import { summarizeCardItems } from './card-item-summary';

type PasCardEntry = PersistentReportEntry & { card_id?: string; card_status?: string };
type Props = {
  entry: PasCardEntry;
  lookupCards: () => Promise<void>;
  sampleDetail?: CardDetail;
  samplePortraitUrl?: string;
  onSampleChange?(update: (current: CardDetail) => CardDetail): void;
  onAnswer?(answer: string): void;
};
const EMPTY_PENDING_CONFIRMATIONS: Readonly<Record<number, boolean>> = {};

export function PasCardExpansion({ entry, lookupCards, sampleDetail, samplePortraitUrl, onSampleChange, onAnswer }: Props) {
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
  const card = sampleDetail?.card ?? storedCard;
  const detail = sampleDetail ?? storedDetail;
  const isSample = Boolean(sampleDetail && onSampleChange);
  const assignee = catalog?.sessionList?.find(session => session.agentSessionId === card?.assigneeSessionId)
    ?? detail?.sessions.find(session => session.sessionId === card?.assigneeSessionId);
  const portraitNodeId = assignee?.nodeId ?? card?.nodeId;
  const portraitAgentId = assignee?.agentId ?? card?.assigneeAgentId;
  const portraitUrl = samplePortraitUrl ?? (portraitNodeId && portraitAgentId
    ? `/api/nodes/${encodeURIComponent(portraitNodeId)}/agents/${encodeURIComponent(portraitAgentId)}/portrait`
    : '');

  useEffect(() => {
    if (sampleDetail || entry.card_id || cardId || cardNumber === null) return;
    void lookupCards();
  }, [cardId, cardNumber, entry.card_id, lookupCards, sampleDetail]);
  useEffect(() => {
    if (!cardId || isSample) return;
    void useCardStore.getState().loadCard(cardId).catch(() => undefined);
  }, [cardId, isSample]);

  const errorAlert = error ? <p role="alert" className="v3-card-error">{error}</p> : null;
  if (!card) return errorAlert ?? <div className="v3-detail-section">카드를 불러오는 중…</div>;

  const questions = detail?.questions ?? [];
  const isOpenQuestion = (question: NonNullable<CardDetail['questions']>[number]) =>
    question.answer === null && question.answeredAt === null && !question.withdrawnAt;
  const question = (entry.question_id ? questions.find(item => item.id === entry.question_id && isOpenQuestion(item)) : undefined)
    ?? questions.find(isOpenQuestion);
  const items = card.items ?? [];
  const targetItemRow = targetItemId === null ? undefined : items.find(item => item.id === targetItemId);
  const summary = summarizeCardItems(items, pendingConfirmations);
  const recentComments = [...(detail?.comments ?? [])]
    .filter(comment => comment.kind !== 'note')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-2);
  const commentsDetail = detail ? { ...detail, comments: recentComments } : undefined;

  const changeSample = (update: (current: CardDetail) => CardDetail) => onSampleChange?.(update);
  const confirmItem = async (itemId: number, confirmed: boolean) => {
    if (isSample) {
      changeSample(current => ({ ...current, card: { ...current.card, items: current.card.items?.map(item => item.id === itemId
        ? confirmed
          ? { ...item, state: 'done', confirmed: { at: new Date().toISOString(), rev: item.rev }, display: 'confirmed' }
          : { ...item, state: 'doing', confirmed: null, display: 'changed', reopened: '샘플에서 확인을 풀었습니다.' }
        : item) } }));
      return;
    }
    if (cardId) await useCardStore.getState().confirmItem(cardId, itemId, confirmed);
  };
  const targetItem = (itemId: number) => {
    setTargetItemId(itemId);
    setFocusRequest(request => request + 1);
  };
  const send = async (body: string) => {
    if (!body.trim() || pending) return false;
    setPending(true);
    try {
      if (isSample) {
        const now = new Date().toISOString();
        const comment: CardComment = { id: crypto.randomUUID(), cardId: card.id, authorKind: 'user', authorId: 'sample-user', sessionId: null,
          kind: 'comment', ...(targetItemId === null ? {} : { itemId: targetItemId }), body: body.trim(), createdAt: now };
        changeSample(current => ({ ...current,
          card: { ...current.card, items: targetItemId === null ? current.card.items : current.card.items?.map(item => item.id === targetItemId
            ? { ...item, state: 'doing', confirmed: null, fixOpen: item.fixOpen + 1, display: 'fix' } : item) },
          comments: [...(current.comments ?? []), comment],
          questions: question ? current.questions.map(item => item.id === question.id ? { ...item, answer: body.trim(), answeredAt: now } : item) : current.questions,
        }));
        if (question) onAnswer?.(body.trim());
      } else if (cardId && targetItemId !== null) {
        await useCardStore.getState().addComment(cardId, body.trim(), cardMutationKey(), targetItemId);
      } else if (cardId && question) {
        await useCardStore.getState().mutate(cardId, `/questions/${encodeURIComponent(question.id)}/answer`, { answer: body.trim() });
      } else if (cardId) {
        await useCardStore.getState().addComment(cardId, body.trim(), cardMutationKey());
      }
      setTargetItemId(null);
      return true;
    } catch {
      return false;
    } finally {
      setPending(false);
    }
  };

  return <div className="pas-report-card-preview" data-testid="pas-card-expansion">
    <CardNowPanel embedded now={question && card.now ? { ...card.now, ask: null } : card.now} itemsCount={items.length} activeCount={summary.activeCount} />
    <CardCheckItems items={items} pendingConfirmations={pendingConfirmations} onConfirmChange={confirmItem} onTargetItem={targetItem} />
    <CardTimeline card={card} detail={commentsDetail} portraitUrl={portraitUrl} userPortraitUrl={user?.picture ?? ''} commentsOnly pending={pending} onAnswer={() => {}} />
    {cardId ? <Button variant="link" className="text-foreground" render={<a href={`/?card=${encodeURIComponent(cardId)}`} onClick={internalLinkClick} />}>카드 열기</Button> : null}
    {targetItemId !== null ? <div className="v3-card-target-notice" role="status"><span>대상: {targetItemId}번 {targetItemRow?.title ?? '항목'}</span><button type="button" aria-label="커멘트 대상 해제" onClick={() => setTargetItemId(null)}>해제</button></div> : null}
    {errorAlert}
    <CardCommentInput cardId={cardId ?? entry.key} nodeId={card.nodeId} sessionId={card.assigneeSessionId} pending={pending} focusRequest={focusRequest}
      placeholder={targetItemId !== null ? '커멘트' : question ? '질문에 답하기' : '커멘트'} onSend={send} />
  </div>;
}

export function PasCardExpansionStatus({ entry }: { entry: PasCardEntry }) {
  if (entry.key.startsWith('cq_')) return <CardStatusChip card={{ status: 'blocked', blockedKind: 'question' }} />;
  if (!entry.card_status) return null;
  return <CardStatusChip card={{ status: entry.card_status as CardRow['status'], blockedKind: null }} />;
}
