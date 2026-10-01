import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import { useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { CardRow } from './CardRow';

export const BOARD_COLUMNS = [
  ['todo', '드래프트'], ['queued', '대기'], ['running', '실행 중'],
  ['blocked', '막힘'], ['review', '검수 대기'], ['done', '완료'],
] as const;

/** Without a controlled folder option the global board always includes done. */
export function CardBoard({ api, cards, onOpen, includeCompleted = true, onIncludeCompletedChange, global = false }: {
  api: ApiClient | null; cards: readonly CardDto[]; onOpen(id: string): void;
  includeCompleted?: boolean; onIncludeCompletedChange?(value: boolean): void; global?: boolean;
}) {
  const t = useTokens();
  const active = cards.filter((card) => !card.archived && card.status !== 'cancelled');
  return <ScrollView horizontal testID="card-board" style={{ flex: 1 }} showsHorizontalScrollIndicator={false}
    contentContainerStyle={{ gap: t.cardLayout.gap, alignItems: 'stretch' }}>
    {BOARD_COLUMNS.map(([status, label]) => {
      const items = active.filter((card) => card.status === status);
      const hidden = status === 'done' && !includeCompleted;
      return <View key={status} testID={`card-board-column-${status}`} style={{ width: t.tabletShell.folderPane.maxWidth, flexShrink: 0, gap: t.uiSpacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
          <Text style={{ ...t.foundation.typography.section, color: t.colors.textPrimary }}>{label}</Text>
          <Text testID={`card-board-count-${status}`} style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{items.length}</Text>
        </View>
        <ScrollView testID={`card-board-scroll-${status}`} style={{ flex: 1 }} showsVerticalScrollIndicator={false}
          contentContainerStyle={{ gap: t.cardLayout.gap, paddingBottom: t.cardLayout.padding }}>
          {hidden && items.length ? <View style={{ gap: t.uiSpacing.md }}>
            <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>완료 {items.length}개 숨김</Text>
            {onIncludeCompletedChange ? <GlassButton accessibilityLabel="숨긴 완료 카드 보기" onPress={() => onIncludeCompletedChange(true)}>
              <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>완료 포함</Text>
            </GlassButton> : null}
          </View> : items.length && !hidden ? items.map((card) => <CardRow key={card.id} api={api} card={card} board today={global} onOpen={() => onOpen(card.id)} />)
            : <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>카드가 없습니다.</Text>}
        </ScrollView>
      </View>;
    })}
  </ScrollView>;
}
