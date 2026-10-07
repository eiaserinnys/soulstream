import React, { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { CardRow } from '../components/planner/CardRow';
import { PersistentSessionTaskList } from '../components/persistent/PersistentSessionTaskList';
import { SwayCharacter } from '../components/persistent/SwayCharacter';
import { createPersistentReviewApi, persistentReviewCards } from './persistent-review-fixtures';
import { ReviewSection } from './ReviewSection';
import { useTokens } from '../theme';
import { ReviewPersistentFullscreen } from './ReviewPersistentFullscreen';
import { ReviewPersistentButtons } from './ReviewPersistentButtons';

const { summaryCard } = persistentReviewCards;

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
  return sample === 'buttons' ? <ReviewPersistentButtons />
    : sample === 'screen' || sample === 'entry' || sample === 'startup' ? <ReviewPersistentFullscreen /> : <PersistentParts />;
}

function PersistentParts() {
  const t = useTokens();
  const query = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const sample = query.get('sample') ?? 'all';
  const state = query.get('state');
  const previewWidth = Number(query.get('width')) || undefined;
  const api = useMemo(() => createPersistentReviewApi(state), [state]);
  const paper = { flex: 1, minHeight: 0, backgroundColor: t.persistentSession.paper } as const;
  const preview = <View testID="persistent-review-paper" style={paper}>
    {sample === 'list' ? <View style={{ width: previewWidth, alignSelf: previewWidth ? 'center' : 'stretch', flex: 1 }}>
      <PersistentSessionTaskList api={api} onOpenCard={recordReviewOpen} />
    </View> : null}
    {sample === 'row' ? <View style={{ width: previewWidth, alignSelf: previewWidth ? 'center' : 'stretch', flex: 1, justifyContent: 'center' }}>
      <CardRow api={api} card={summaryCard} variant="summary" onOpen={() => recordReviewOpen(summaryCard.id)} />
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
    </ScrollView> : null}
  </View>;

  if (sample !== 'all') return <View style={[paper, { padding: t.cardLayout.padding }]}>
    <ReviewSection title={sample === 'list' ? '작업 목록' : '요약 행'}>
      <View style={{ flex: 1, minHeight: 0 }}>{preview}</View>
    </ReviewSection>
  </View>;
  return preview;
}
