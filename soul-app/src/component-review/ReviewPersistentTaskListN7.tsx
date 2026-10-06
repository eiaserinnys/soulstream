import React, { useMemo } from 'react';
import { View, useWindowDimensions } from 'react-native';
import type { ApiClient } from '../api/client';
import type { CardDto, CardStatus } from '../api/cardTypes';
import { CardDetailContent } from '../components/planner/CardDetailSheet';
import { PersistentSessionTaskList } from '../components/persistent/PersistentSessionTaskList';
import { useTokens } from '../theme';
import { createPersistentReviewApi, persistentReviewCards } from './persistent-review-fixtures';
import { ReviewSection } from './ReviewSection';

const longTitle = '좁은 화면에서도 카드 번호와 제목의 시작선을 유지하고 긴 내용을 겹치지 않게 확인하는 검수용 카드 제목';
const summaryCard = { ...persistentReviewCards.longCard, id: 'public-persistent-n7-summary', number: 1024,
  status: 'running' as CardStatus, title: longTitle };
const taskCards: CardDto[] = [7, 98, 412, 1000, 1024].map((number, index) => ({
  ...summaryCard,
  id: `public-persistent-n7-${number}`,
  number,
  status: (['running', 'blocked', 'review', 'queued', 'todo'] as CardStatus[])[index],
  title: `${longTitle} · ${number}`,
}));

export function ReviewPersistentTaskListN7() {
  const t = useTokens();
  const { width } = useWindowDimensions();
  const query = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const targetWidth = Number(query.get('width')) || undefined;
  const summary = query.get('view') === 'summary';
  const api = useMemo(() => {
    const base = createPersistentReviewApi(null);
    return {
      ...base,
      listCards: async () => ({ cards: taskCards }),
      getCard: async (cardId: string) => ({ ...(await base.getCard(cardId)), card: summaryCard }),
    } as ApiClient;
  }, []);

  return <View style={{ flex: 1, padding: t.cardLayout.padding, backgroundColor: t.colors.background }}>
    <ReviewSection title={`${summary ? '카드 읽기 요약' : '작업 목록'} · ${Math.round(targetWidth ?? width)}`}>
      <View testID="persistent-task-list-n7-preview" style={{ width: targetWidth, alignSelf: targetWidth ? 'center' : 'stretch', flex: 1, minHeight: 0 }}>
        {summary
          ? <CardDetailContent api={api} cardId={summaryCard.id} variant="readSummary" fitContent onOpenCard={() => {}} onClose={() => {}} />
          : <PersistentSessionTaskList api={api} onOpenCard={() => {}} />}
      </View>
    </ReviewSection>
  </View>;
}
