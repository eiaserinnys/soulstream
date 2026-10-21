import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, View, useWindowDimensions } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardCheckItem } from '../../api/cardTypes';
import type { PersistentReportEntry } from '../../api/types';
import { useCardActions } from '../../hooks/useCardActions';
import { useCardComments } from '../../hooks/useCardComments';
import { useCardDetail } from '../../hooks/useCardDetail';
import { useCardItems } from '../../hooks/useCardItems';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import { useTokens } from '../../theme';
import { CardCheckItems } from '../planner/CardCheckItems';
import { CardCommentComposer, type CardCommentComposerHandle } from '../planner/CardCommentComposer';
import { CardNowPanel } from '../planner/CardNowPanel';
import { cardDetailStyles } from '../planner/CardDetail.styles';
import { CardTimeline } from '../planner/CardTimeline';
import { GlassButton } from '../GlassSurface';

type Lookup = { key: string; number: number; cardId: string | null; loading: boolean; error?: string };

export function PersistentReportCardExpansion({ api, entry }: { api: ApiClient | null; entry: PersistentReportEntry }) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const { width } = useWindowDimensions();
  const number = entry.card_numbers.length === 1 ? entry.card_numbers[0] : null;
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [targetItem, setTargetItem] = useState<CardCheckItem | null>(null);
  const [composerBusy, setComposerBusy] = useState(false);
  const composer = useRef<CardCommentComposerHandle>(null);
  const openLink = useOpenContentLink();

  useEffect(() => {
    if (entry.card_id || number === null || !api) {
      setLookup(null);
      return;
    }
    let cancelled = false;
    setLookup({ key: entry.key, number, cardId: null, loading: true });
    void api.listCards(undefined, { includeCompleted: true }).then(({ cards }) => {
      if (cancelled) return;
      setLookup({ key: entry.key, number, cardId: cards.find(card => card.number === number)?.id ?? null, loading: false });
    }).catch(cause => {
      if (cancelled) return;
      setLookup({ key: entry.key, number, cardId: null, loading: false,
        error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { cancelled = true; };
  }, [api, entry.card_id, entry.key, number]);

  const currentLookup = lookup?.key === entry.key && lookup.number === number ? lookup : null;
  const cardId = entry.card_id ?? currentLookup?.cardId ?? null;
  const { detail, error } = useCardDetail(api, cardId);
  const itemActions = useCardItems(api, cardId ?? '');
  const comments = useCardComments(api, cardId ?? '');
  const actions = useCardActions(api);
  const question = [...(detail?.questions ?? [])].reverse().find(item => item.answer === null && !item.withdrawnAt);
  const latestComments = useMemo(() => (detail?.comments ?? []).filter(comment => comment.kind !== 'note')
    .slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-2), [detail?.comments]);
  const timelineDetail = useMemo(() => detail ? { ...detail, comments: latestComments } : null, [detail, latestComments]);
  const onBusyChange = useCallback((busy: boolean) => setComposerBusy(busy), []);
  const onChooseAnswer = useCallback((answer: string) => composer.current?.chooseAnswer(answer), []);
  const focusComposer = useCallback(() => composer.current?.focus(), []);
  const onOpenCard = useCallback(() => {
    if (cardId) void openLink(`/?card=${encodeURIComponent(cardId)}`);
  }, [cardId, openLink]);

  if (!api) return <Text style={styles.error}>카드를 불러오지 못했습니다.</Text>;
  if (number === null && !entry.card_id) return <Text style={styles.error}>카드 연결을 찾지 못했습니다.</Text>;
  if (currentLookup?.loading || (!entry.card_id && !currentLookup)) return <ActivityIndicator color={t.colors.accent} />;
  if (currentLookup?.error || error) return <Text style={styles.error}>{currentLookup?.error ?? error}</Text>;
  if (!cardId) return <Text style={styles.error}>카드 연결을 찾지 못했습니다.</Text>;
  if (!detail || detail.card.id !== cardId) return <ActivityIndicator color={t.colors.accent} />;

  return <View testID={`persistent-report-card-expansion-${entry.key}`} style={{ gap: t.uiSpacing.lg }}>
    {detail.card.now ? <CardNowPanel now={detail.card.now} history={detail.nowHistory ?? []} /> : null}
    <CardCheckItems cardId={cardId} items={itemActions.items} pendingConfirmations={itemActions.pendingConfirmations}
      initiallyConfirmedIds={[]} newlyConfirmedIds={[]} onConfirm={itemActions.confirm}
      onSetTarget={item => { setTargetItem(item); requestAnimationFrame(focusComposer); }} onRecentConfirmation={() => {}} paneWidth={width} />
    {timelineDetail ? <CardTimeline detail={timelineDetail} onChooseAnswer={onChooseAnswer} commentsOnly /> : null}
    <GlassButton variant="plain" size="compact" accessibilityLabel="카드 열기" onPress={onOpenCard}>
      <Text style={{ ...t.foundation.typography.body, color: t.colors.link }}>카드 열기</Text>
    </GlassButton>
    <CardCommentComposer ref={composer} api={api} cardId={cardId} sessionId={detail.card.assigneeSessionId} nodeId={detail.card.nodeId}
      question={question} cardLoaded locked={actions.pending || comments.pending || composerBusy} sending={actions.pending || comments.pending}
      onBusyChange={onBusyChange} sendComment={comments.send} runMutation={actions.run} embedded
      placeholder={question ? '질문에 답하기' : '커멘트'} targetItem={targetItem}
      onReleaseTarget={() => setTargetItem(null)} onTargetSent={() => setTargetItem(null)} />
  </View>;
}
