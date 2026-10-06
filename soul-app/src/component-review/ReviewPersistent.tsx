import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { CardRow } from '../components/planner/CardRow';
import { PersistentSessionTaskList } from '../components/persistent/PersistentSessionTaskList';
import { SwayCharacter } from '../components/persistent/SwayCharacter';
import { createPersistentReviewApi, persistentReviewCards } from './persistent-review-fixtures';
import { ReviewSection } from './ReviewSection';
import { useTokens } from '../theme';
import { ReviewPersistentFullscreen } from './ReviewPersistentFullscreen';

const { summaryCard, realisticCard, twoImageCard, blankParagraphCard, sessionNamedCard, sessionNullLabelCard, longCard, noProgressCard, sparseCard } = persistentReviewCards;

function CharacterSample({ label, width, height, motionEnabled, shown = true }: {
  label: string; width: number; height: number; motionEnabled: boolean; shown?: boolean;
}) {
  const t = useTokens();
  return <View style={{ alignItems: 'center', gap: t.spacing.sm }}>
    <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>{label}</Text>
    <View style={{ alignSelf: 'center' }}>
      <SwayCharacter width={width} height={height} shown={shown} motionEnabled={motionEnabled} active />
    </View>
  </View>;
}

function recordReviewOpen(cardId: string) {
  if (typeof window !== 'undefined') (window as Window & { __persistentReviewOpenedCard?: string }).__persistentReviewOpenedCard = cardId;
}

export function ReviewPersistent() {
  const sample = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('sample');
  return sample === 'screen' || sample === 'entry' ? <ReviewPersistentFullscreen /> : <PersistentParts />;
}

function PersistentParts() {
  const t = useTokens();
  const query = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const sample = query.get('sample') ?? 'all';
  const detailCase = query.get('case') ?? 'summary';
  const state = query.get('state');
  const previewWidth = Number(query.get('width')) || undefined;
  const previewHeight = Number(query.get('height')) || undefined;
  const api = useMemo(() => createPersistentReviewApi(state), [state]);
  const selectedCard = detailCase === 'realistic' ? realisticCard : detailCase === 'two-images' ? twoImageCard
    : detailCase === 'blank-paragraphs' ? blankParagraphCard
      : detailCase === 'session-named' ? sessionNamedCard : detailCase === 'session-null-label' ? sessionNullLabelCard
    : detailCase === 'long' ? longCard : detailCase === 'no-progress' ? noProgressCard
      : detailCase === 'sparse' ? sparseCard : summaryCard;
  const paper = { flex: 1, minHeight: 0, backgroundColor: t.persistentSession.paper } as const;
  const detailPanel = { flex: 1, minHeight: 0, width: '100%' as const, alignSelf: 'stretch' as const,
    backgroundColor: t.persistentSession.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: t.persistentSession.line,
    borderRadius: t.foundation.radius.panel, overflow: 'hidden' as const };
  const panelHeight = previewHeight ? { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' as const, height: previewHeight } : undefined;
  const preview = <View testID="persistent-review-paper" style={paper}>
    {sample === 'list' ? <View style={{ width: previewWidth, alignSelf: previewWidth ? 'center' : 'stretch', flex: 1 }}>
      <PersistentSessionTaskList api={api} onOpenCard={recordReviewOpen} />
    </View> : null}
    {sample === 'row' ? <View style={{ width: previewWidth, alignSelf: previewWidth ? 'center' : 'stretch', flex: 1, justifyContent: 'center' }}>
      <CardRow api={api} card={summaryCard} variant="summary" onOpen={() => recordReviewOpen(summaryCard.id)} />
    </View> : null}
    {sample === 'card' ? <View testID="persistent-review-card-panel" style={[detailPanel, previewWidth ? { width: previewWidth, alignSelf: 'center' } : undefined, panelHeight]}>
      <CardDetailContent api={api} cardId={selectedCard.id} variant="readSummary" onOpenCard={() => recordReviewOpen(selectedCard.id)} onClose={() => {}} />
    </View> : null}
    {sample === 'all' ? <ScrollView testID="persistent-review-all" style={{ flex: 1 }} contentContainerStyle={{ padding: t.cardLayout.padding, gap: t.uiSpacing.xxl }}>
      <ReviewSection title="영구 세션 · 캐릭터 부품">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: t.spacing.xl }}>
          <CharacterSample label="가로 iPad · 움직임 켬" width={152} height={228} motionEnabled />
          <CharacterSample label="세로 iPad · 움직임 켬" width={126} height={189} motionEnabled />
          <CharacterSample label="움직임 끔" width={152} height={228} motionEnabled={false} />
          <CharacterSample label="표시 끔" width={152} height={228} motionEnabled shown={false} />
        </View>
      </ReviewSection>
      <ReviewSection title="작업 목록">
        <PersistentSessionTaskList api={api} onOpenCard={recordReviewOpen} />
      </ReviewSection>
      <ReviewSection title="요약 행">
        <CardRow api={api} card={summaryCard} variant="summary" onOpen={() => recordReviewOpen(summaryCard.id)} />
      </ReviewSection>
      <ReviewSection title="카드 읽기 요약">
        <View style={detailPanel}>
          <CardDetailContent api={api} cardId={summaryCard.id} variant="readSummary" onOpenCard={() => recordReviewOpen(summaryCard.id)} onClose={() => {}} />
        </View>
      </ReviewSection>
    </ScrollView> : null}
  </View>;

  if (sample !== 'all') return <View style={[paper, { padding: t.cardLayout.padding }]}>
    <ReviewSection title={sample === 'list' ? '작업 목록' : sample === 'row' ? '요약 행' : '카드 읽기 요약'}>
      <View style={{ flex: 1, minHeight: 0 }}>{preview}</View>
    </ReviewSection>
  </View>;
  return preview;
}
