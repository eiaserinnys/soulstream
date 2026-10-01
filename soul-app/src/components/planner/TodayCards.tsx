import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { PlannerToday } from '../../api/plannerTypes';
import { useTodayCardGroups } from '../../hooks/useTodayCardGroups';
import { useTokens } from '../../theme';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { CardRow } from './CardRow';
import { CardQueue } from './CardQueue';
import { CardCreateSheet } from './CardCreateSheet';
import { CardDetailSheet } from './CardDetailSheet';
import { todayCardStyles } from './TodayCard.styles';

export function TodayCards({ api, data, onDragStateChange, onOpenSession }: {
  api: ApiClient | null; data: PlannerToday | undefined; onDragStateChange(dragging: boolean): void; onOpenSession?(id: string): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => todayCardStyles(t), [t]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const groups = useTodayCardGroups(data).filter((group) => group.cards.length > 0 || group.status === 'attention');
  return <View style={styles.groups} testID="today-cards">
    {groups.every((group) => group.cards.length === 0) ? <View testID="today-cards-empty" style={styles.empty}>
      <Text style={styles.emptyTitle}>지금은 확인할 것이 없습니다</Text>
      <Text style={styles.emptyText}>아래에서 새 세션을 시작하세요.</Text>
    </View> : null}
    {groups.map((group) => <View key={group.status} style={styles.section} testID={`today-cards-${group.status}`}>
      <PlannerSectionHeader title={group.title} count={group.cards.length} actionLabel={group.status === 'attention' ? '+ 카드' : undefined} onAction={group.status === 'attention' ? () => setAdding(true) : undefined} />
      {group.status === 'queued' ? <CardQueue api={api} cards={group.cards} onOpen={setSelected} onDragStateChange={onDragStateChange} /> :
        <View style={{ gap: t.cardLayout.gap }}>{group.cards.map((card) => <CardRow today key={card.id} api={api} card={card} onOpen={() => setSelected(card.id)} />)}</View>}
    </View>)}
    <CardDetailSheet api={api} cardId={selected} onClose={() => setSelected(null)} onOpenSession={onOpenSession} />
    {adding ? <CardCreateSheet api={api} onClose={() => setAdding(false)} /> : null}
  </View>;
}
