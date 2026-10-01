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

export function FolderCards({ api, folderId, active = true, onOpenSession }: {
  api: ApiClient | null; folderId: string; active?: boolean; onOpenSession?(id: string): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardStyles(t), [t]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, loading, error } = usePlannerFolder(api, folderId, active);
  return <View testID="folder-cards" style={styles.section}>
    <PlannerSectionHeader testID="planner-section-header-cards" title="카드" actionLabel="카드 추가" onAction={() => setAdding((open) => !open)} />
    {adding ? <CardComposer api={api} folderId={folderId} onCreated={() => setAdding(false)} /> : null}
    {loading && !data ? <ActivityIndicator color={t.colors.accent} /> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <View style={{ gap: t.cardLayout.gap }}>{data?.cards.map((card) => <CardRow key={card.id} api={api} card={card} onOpen={() => setSelected(card.id)} />)}</View>
    <CardDetailSheet api={api} cardId={selected} onClose={() => setSelected(null)} onOpenSession={onOpenSession} />
  </View>;
}
