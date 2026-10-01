import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import type { ApiClient } from '../../api/client';
import { useCardList } from '../../hooks/useCardList';
import { useDeviceType, useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LiquidGlassButton } from '../LiquidGlassButton';
import { AppModalSurface } from '../AppModalSurface';
import { CardBoard } from './CardBoard';
import { CompletedCardsToggle } from './CompletedCardsToggle';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { CardCreateSheet } from './CardCreateSheet';
import type { BoardPosition } from '../../lib/card-board-layout';

export interface FolderCardDisplay { includeCompleted: boolean; onChange(value: boolean): void; }
export interface CardBoardWorkspaceHandle { openCreate(): void; openExpanded(): void; }

/** Workspace owns scope and restore snapshots, including across native Modal remounts. */
export const CardBoardWorkspace = forwardRef<CardBoardWorkspaceHandle, {
  api: ApiClient | null; folderId?: string; cardDisplay: FolderCardDisplay; onOpen(id: string): void; externalHeader?: boolean;
}>(function CardBoardWorkspace({ api, folderId, cardDisplay, onOpen, externalHeader = false }, ref) {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const { cards, loading, error, refresh } = useCardList(api, folderId);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<BoardPosition | null>(null);
  const position = useRef<BoardPosition>({ x: 0, lanes: {} });
  useImperativeHandle(ref, () => ({ openCreate: () => setAdding(true),
    openExpanded: () => setExpanded({ ...position.current, lanes: { ...position.current.lanes } }) }), []);
  const completedCount = cards.filter((card) => card.status === 'done').length;
  const board = (initialPosition?: BoardPosition, expandedBoard = false) => <CardBoard api={api} cards={cards} phone={phone}
    includeCompleted={cardDisplay.includeCompleted} initialPosition={initialPosition}
    onPositionChange={expandedBoard ? undefined : (next) => { position.current = next; }}
    onOpen={(id) => { if (expandedBoard) setExpanded(null); onOpen(id); }} />;
  const heading = <View style={{ paddingHorizontal: phone ? t.cardLayout.padding : 0, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.uiSpacing.sm }}>
    <View style={{ flexGrow: 1 }}><PlannerSectionHeader title={folderId ? '현재 폴더 · 카드' : '전체 · 카드'} /></View>
    <CompletedCardsToggle includeCompleted={cardDisplay.includeCompleted} completedCount={completedCount} onChange={cardDisplay.onChange} />
    <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round} accessibilityLabel="드래프트 카드 추가" onPress={() => setAdding(true)}>
      <Ionicons name="add-outline" size={t.iconSize.standard} color={t.colors.textPrimary} />
    </LiquidGlassButton>
    {!phone ? <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round} accessibilityLabel={expanded ? '보드 확대 닫기' : '보드 확대'} onPress={() => setExpanded(expanded ? null : { ...position.current, lanes: { ...position.current.lanes } })}>
      <Ionicons name={expanded ? 'close-outline' : 'expand-outline'} size={t.iconSize.standard} color={t.colors.textPrimary} />
    </LiquidGlassButton> : null}
  </View>;
  return <View testID="card-board-workspace" style={{ flex: 1, paddingHorizontal: phone ? 0 : t.cardLayout.padding, paddingVertical: t.cardLayout.padding, gap: t.uiSpacing.md }}>
    {externalHeader ? null : heading}
    {loading ? <ActivityIndicator color={t.colors.accent} /> : null}
    {error ? <View style={{ gap: t.uiSpacing.sm }}>
      <Text style={{ ...t.foundation.typography.body, color: t.colors.error }}>{error}</Text>
      <GlassButton accessibilityLabel="보드 다시 조회" onPress={refresh}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 시도</Text></GlassButton>
    </View> : null}
    {board()}
    {adding ? <CardCreateSheet api={api} folderId={folderId} onClose={() => setAdding(false)} /> : null}
    {expanded ? <AppModalSurface visible modalId="modal_card_detail" variant="expanded" presentationStyle="pageSheet" onRequestClose={() => setExpanded(null)}>
      <GestureHandlerRootView style={{ flex: 1 }}><View testID="card-board-expanded" style={{ flex: 1, padding: t.cardLayout.padding, gap: t.uiSpacing.md }}>
        {heading}{board(expanded, true)}
      </View></GestureHandlerRootView>
    </AppModalSurface> : null}
  </View>;
});
