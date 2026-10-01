import React from 'react';
import { Text, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import { useTokens } from '../../theme';
import { CardRow } from './CardRow';

export function FolderCardList({ api, cards, includeCompleted, onOpen }: {
  api: ApiClient | null; cards: readonly CardDto[]; includeCompleted: boolean; onOpen(id: string): void;
}) {
  const t = useTokens();
  const visible = cards.filter((card) => includeCompleted || card.status !== 'done');
  return <View style={{ gap: t.cardLayout.gap }}>
    {visible.map((card) => <CardRow key={card.id} api={api} card={card} onOpen={() => onOpen(card.id)} />)}
    {!visible.length ? <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>표시할 카드가 없습니다.</Text> : null}
  </View>;
}
