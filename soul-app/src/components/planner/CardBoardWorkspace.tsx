import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import { useCardList } from '../../hooks/useCardList';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { CardBoard } from './CardBoard';
import { CompletedCardsToggle } from './CompletedCardsToggle';
import { PlannerSectionHeader } from './PlannerSectionHeader';

export interface FolderCardDisplay {
  includeCompleted: boolean;
  onChange(value: boolean): void;
}

export function CardBoardWorkspace({ api, folderId, cardDisplay, onOpen }: {
  api: ApiClient | null; folderId?: string; cardDisplay: FolderCardDisplay; onOpen(id: string): void;
}) {
  const t = useTokens();
  const { cards, loading, error, refresh } = useCardList(api, folderId);
  const completedCount = cards.filter((card) => card.status === 'done').length;
  return <View testID="card-board-workspace" style={{ flex: 1, padding: t.cardLayout.padding, gap: t.uiSpacing.md }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.uiSpacing.sm }}>
      <View style={{ flexGrow: 1 }}><PlannerSectionHeader title={folderId ? '현재 폴더 · 보드' : '전체 · 보드'} /></View>
      {folderId ? <CompletedCardsToggle includeCompleted={cardDisplay.includeCompleted} completedCount={completedCount} onChange={cardDisplay.onChange} /> : null}
    </View>
    {loading ? <ActivityIndicator color={t.colors.accent} /> : null}
    {error ? <View style={{ gap: t.uiSpacing.sm }}>
      <Text style={{ ...t.foundation.typography.body, color: t.colors.error }}>{error}</Text>
      <GlassButton accessibilityLabel="보드 다시 조회" onPress={refresh}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 시도</Text></GlassButton>
    </View> : null}
    <CardBoard api={api} cards={cards} global={!folderId} includeCompleted={!folderId || cardDisplay.includeCompleted}
      onIncludeCompletedChange={folderId ? cardDisplay.onChange : undefined} onOpen={onOpen} />
  </View>;
}
