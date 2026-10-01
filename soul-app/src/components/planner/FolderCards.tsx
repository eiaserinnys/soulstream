import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import { usePlannerFolder } from '../../hooks/usePlannerFolder';
import { useTokens } from '../../theme';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { CardRow } from './CardRow';
import { CardComposer } from './CardComposer';
import { CardDetailSheet } from './CardDetailSheet';
import { cardStyles } from './Card.styles';
import { CompletedCardsToggle } from './CompletedCardsToggle';
import { FolderCardList } from './FolderCardList';
import type { FolderCardDisplay } from './CardBoardWorkspace';

export function FolderCards({ api, folderId, active = true, onOpenSession, cardDisplay }: {
  api: ApiClient | null; folderId: string; active?: boolean; onOpenSession?(id: string): void; cardDisplay?: FolderCardDisplay;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardStyles(t), [t]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, loading, error } = usePlannerFolder(api, folderId, active);
  return <View testID="folder-cards" style={styles.section}>
    {cardDisplay ? <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.uiSpacing.sm }}>
      <View style={{ flexGrow: 1 }}><PlannerSectionHeader testID="planner-section-header-cards" title="카드" actionLabel="카드 추가" onAction={() => setAdding((open) => !open)} /></View>
      <CompletedCardsToggle includeCompleted={cardDisplay.includeCompleted}
        completedCount={data?.cards.filter((card) => card.status === 'done').length ?? 0} onChange={cardDisplay.onChange} />
    </View> : <PlannerSectionHeader testID="planner-section-header-cards" title="카드" actionLabel="카드 추가" onAction={() => setAdding((open) => !open)} />}
    {adding ? <CardComposer api={api} folderId={folderId} onCreated={() => setAdding(false)} /> : null}
    {loading && !data ? <ActivityIndicator color={t.colors.accent} /> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {cardDisplay ? <FolderCardList api={api} cards={data?.cards ?? []} includeCompleted={cardDisplay.includeCompleted} onOpen={setSelected} />
      : <View style={{ gap: t.cardLayout.gap }}>{data?.cards.map((card) => <CardRow key={card.id} api={api} card={card} onOpen={() => setSelected(card.id)} />)}</View>}
    <CardDetailSheet api={api} cardId={selected} onClose={() => setSelected(null)} onOpenSession={onOpenSession} />
  </View>;
}
