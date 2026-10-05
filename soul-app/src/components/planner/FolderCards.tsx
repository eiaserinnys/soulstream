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
import { useCardDisplay } from '../../hooks/useCardDisplay';
import { useCompletedCards } from '../../hooks/useCompletedCards';
import { CompletedCardCollection } from './CompletedCardCollection';
import { LiquidGlassButton } from '../LiquidGlassButton';
import Ionicons from '@expo/vector-icons/Ionicons';

export function FolderCards({ api, folderId, active = true, onOpenSession, cardDisplay:controlledDisplay,virtualHost=false }: {
  api: ApiClient | null; folderId: string; active?: boolean; onOpenSession?(id: string): void; cardDisplay?: FolderCardDisplay;
  virtualHost?:boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardStyles(t), [t]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const localDisplay=useCardDisplay(folderId),cardDisplay=controlledDisplay??localDisplay;
  const completed=useCompletedCards(api,folderId,active&&cardDisplay.includeCompleted&&!virtualHost);
  const { data, loading, error } = usePlannerFolder(api, folderId, active,false);
  return <View testID="folder-cards" style={styles.section}>
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.uiSpacing.sm }}>
      <View style={{ flexGrow: 1 }}><PlannerSectionHeader testID="planner-section-header-cards" title="카드"/></View>
      <CompletedCardsToggle includeCompleted={cardDisplay.includeCompleted}
        completedCount={data?.cards.filter((card) => card.status === 'done').length ?? 0} onChange={cardDisplay.onChange} />
      <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round} accessibilityLabel="카드 추가" onPress={()=>setAdding(open=>!open)}><Ionicons name="add-outline" size={t.iconSize.standard} color={t.colors.textPrimary}/></LiquidGlassButton>
    </View>
    {adding ? <CardComposer key={folderId} api={api} folderId={folderId} onCreated={() => setAdding(false)} /> : null}
    {loading && !data ? <ActivityIndicator color={t.colors.accent} /> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <FolderCardList api={api} cards={data?.cards ?? []} includeCompleted={false} onOpen={setSelected}/>
    {!virtualHost&&cardDisplay.includeCompleted?<CompletedCardCollection api={api} browser={completed} onOpen={setSelected}/>:null}
    <CardDetailSheet api={api} cardId={selected} onClose={() => setSelected(null)} onOpenSession={onOpenSession} />
  </View>;
}
