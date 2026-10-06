import React, { useMemo } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import { useCardList } from '../../hooks/useCardList';
import { groupPersistentSessionTasks } from '../../lib/persistent-session-tasks';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { CardRow } from '../planner/CardRow';
import { PlannerSectionHeader } from '../planner/PlannerSectionHeader';

export interface PersistentSessionTaskListProps {
  api: ApiClient | null;
  onOpenCard(cardId: string): void;
}

export function PersistentSessionTaskList({ api, onOpenCard }: PersistentSessionTaskListProps) {
  const t = useTokens();
  const { cards, loading, error, refresh } = useCardList(api);
  const groups = useMemo(() => groupPersistentSessionTasks(cards), [cards]);
  const summaryNumberTemplate = useMemo(() => {
    let longest: string | undefined;
    for (const group of groups) for (const card of group.cards) {
      if (card.number == null) continue;
      const label = `#${card.number}`;
      if (longest == null || label.length > longest.length) longest = label;
    }
    return longest;
  }, [groups]);

  if (loading && cards.length === 0) return <View testID="persistent-task-list-loading" style={{ flex: 1, minHeight: t.foundation.minHeight.row,
    padding: t.foundation.pageInset, alignItems: 'center', justifyContent: 'center' }}>
    <ActivityIndicator color={t.colors.accent} />
  </View>;
  if (error && cards.length === 0) return <View testID="persistent-task-list-error-state" style={{ paddingVertical: t.foundation.pageInset, gap: t.uiSpacing.sm }}>
    <Text testID="persistent-task-list-error" style={{ ...t.foundation.typography.body, color: t.colors.errorText }}>{error}</Text>
    <GlassButton variant="paper" accessibilityLabel="작업 목록 다시 조회" onPress={refresh}>
      <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 시도</Text>
    </GlassButton>
  </View>;
  if (groups.length === 0) return <Text testID="persistent-task-list-empty" style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>
    카드가 없습니다.
  </Text>;

  return <ScrollView testID="persistent-task-list" showsVerticalScrollIndicator={false}
    contentContainerStyle={{ gap: t.uiSpacing.xxl }}>
    {groups.map((group) => <View key={group.status} testID={`persistent-task-group-${group.status}`} style={{ gap: t.uiSpacing.md }}>
      <PlannerSectionHeader title={group.label} variant="quiet" />
      <View>
        {group.cards.map((card) => <CardRow key={card.id} api={api} card={card} variant="summary"
          summaryNumberTemplate={summaryNumberTemplate} onOpen={() => onOpenCard(card.id)} />)}
      </View>
    </View>)}
  </ScrollView>;
}
