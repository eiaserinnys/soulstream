import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, Text, View } from 'react-native';
import { AutomaticRefreshIndicator } from '../AutomaticRefreshIndicator';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import type { ApiClient } from '../../api/client';
import { useCardList } from '../../hooks/useCardList';
import { useCompletedCards } from '../../hooks/useCompletedCards';
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
import { useUIStore } from '../../store/uiStore';
import { FolderWorkspaceReadOverlay } from './FolderWorkspaceReadOverlay';

export interface FolderCardDisplay { includeCompleted: boolean; onChange(value: boolean): void; }
export interface CardBoardWorkspaceHandle { openCreate(): void; openExpanded(): void; }

/** Workspace owns scope and restore snapshots, including across native Modal remounts. */
export const CardBoardWorkspace = forwardRef<CardBoardWorkspaceHandle, {
  api: ApiClient | null; folderId?: string; cardDisplay: FolderCardDisplay; onOpen(id: string): void; externalHeader?: boolean; bottomInset?: number; onExpandedClose?(): void;
}>(function CardBoardWorkspace({ api, folderId, cardDisplay, onOpen, externalHeader = false, bottomInset = 0, onExpandedClose }, ref) {
  const t = useTokens();
  const phone = useDeviceType() === 'phone';
  const { cards, loading, error, refresh } = useCardList(api, folderId);
  const completed=useCompletedCards(api,folderId,cardDisplay.includeCompleted);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<BoardPosition | null>(null);
  const position = useRef<BoardPosition>({ x: 0, lanes: {} });
  const detailVisible = useUIStore(state => state.folderOverlayVisible);
  const detailFocus = useRef<{ focus(options?: { preventScroll?: boolean }): void; isConnected?: boolean } | null>(null);
  const nativeDetailFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!expanded || phone) return;
    useUIStore.getState().setCardBoardExpanded(true);
    return () => {
      useUIStore.getState().closeFolderOverlay();
      useUIStore.getState().setCardBoardExpanded(false);
    };
  }, [Boolean(expanded), folderId, phone]);
  useEffect(() => {
    if (!detailVisible && detailFocus.current) {
      if (detailFocus.current.isConnected) detailFocus.current.focus({ preventScroll: true });
      detailFocus.current = null;
    }
    if (!detailVisible && nativeDetailFocus.current !== null) {
      AccessibilityInfo.setAccessibilityFocus(nativeDetailFocus.current);
      nativeDetailFocus.current = null;
    }
  }, [detailVisible]);
  // Changing scope releases the sheet host before rendering the next folder.
  useEffect(() => { setExpanded(null); }, [folderId]);
  useImperativeHandle(ref, () => ({ openCreate: () => setAdding(true),
    openExpanded: () => setExpanded({ ...position.current, lanes: { ...position.current.lanes } }) }), []);
  const closeExpanded = () => { setExpanded(null); onExpandedClose?.(); };
  const completedCount = completed.cards.length;
  const board = (initialPosition: BoardPosition = position.current, expandedBoard = false) => <CardBoard api={api} cards={[...cards.filter(card=>card.status!=='done'),...completed.cards]} phone={expandedBoard ? phone : true} completed={completed}
    bottomInset={expandedBoard ? 0 : bottomInset}
    includeCompleted={cardDisplay.includeCompleted} hideEmptyLanes={!expandedBoard} initialPosition={initialPosition}
    onPositionChange={(next) => { position.current = next; }}
    onOpen={(id, target) => {
      if (expandedBoard && phone) closeExpanded();
      if (expandedBoard && !phone && typeof document !== 'undefined') detailFocus.current = document.activeElement as HTMLElement;
      if (expandedBoard && !phone && Platform.OS !== 'web' && target !== undefined) nativeDetailFocus.current = target;
      onOpen(id);
    }} />;
  const heading = (expandedBoard = false) => <View style={{ paddingHorizontal: expandedBoard && !phone ? 0 : t.cardLayout.padding, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.uiSpacing.sm }}>
    <View style={{ flexGrow: 1 }}><PlannerSectionHeader title={folderId ? '현재 폴더 · 카드' : '전체 · 카드'} /></View>
    <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round} testID="card-board-create"
      surfaceTestID="card-board-create-visual" accessibilityLabel="드래프트 카드 추가" onPress={() => setAdding(true)}>
      <Ionicons name="add-outline" size={t.iconSize.standard} color={t.colors.textPrimary} />
    </LiquidGlassButton>
    <CompletedCardsToggle includeCompleted={cardDisplay.includeCompleted} completedCount={completedCount} onChange={cardDisplay.onChange} />
    {!phone ? <LiquidGlassButton iconOnly borderRadius={t.foundation.radius.round} accessibilityLabel={expanded ? '보드 확대 닫기' : '보드 확대'} onPress={() => expanded ? closeExpanded() : setExpanded({ ...position.current, lanes: { ...position.current.lanes } })}>
      <Ionicons name={expanded ? 'close-outline' : 'expand-outline'} size={t.iconSize.standard} color={t.colors.textPrimary} />
    </LiquidGlassButton> : null}
  </View>;
  return <View testID="card-board-workspace" style={{ flex: 1, position: 'relative', paddingHorizontal: 0, paddingTop: t.uiSpacing.sm, paddingBottom: t.cardLayout.padding, gap: t.uiSpacing.md }}>
    {externalHeader ? null : heading()}
    {error ? <View style={{ gap: t.uiSpacing.sm }}>
      <Text style={{ ...t.foundation.typography.body, color: t.colors.error }}>{error}</Text>
      <GlassButton accessibilityLabel="보드 다시 조회" onPress={refresh}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 시도</Text></GlassButton>
    </View> : null}
    {board()}
    {loading && !expanded ? <AutomaticRefreshIndicator testID="card-board-auto-progress" style={{ top: 0, right: 0 }} /> : null}
    {adding ? <CardCreateSheet api={api} folderId={folderId} onClose={() => setAdding(false)} /> : null}
    {expanded ? <AppModalSurface visible modalId="modal_card_detail" {...(phone
      ? { variant: 'expanded' as const, presentationStyle: 'pageSheet' as const }
      : { variant: 'board' as const })} onRequestClose={() => {
      if (useUIStore.getState().folderOverlayVisible) useUIStore.getState().closeFolderOverlay();
      else closeExpanded();
    }}>
      <GestureHandlerRootView style={{ flex: 1 }}><View testID="card-board-expanded" style={{ flex: 1, position: 'relative', paddingHorizontal: t.cardLayout.padding, paddingTop: t.uiSpacing.sm, paddingBottom: t.cardLayout.padding, gap: t.uiSpacing.md }}>
        <View style={{ flex: 1, gap: t.uiSpacing.md }} pointerEvents={detailVisible ? 'none' : 'auto'} accessibilityElementsHidden={detailVisible} importantForAccessibility={detailVisible ? 'no-hide-descendants' : 'auto'}>
          {heading(true)}{board(expanded, true)}
        </View>
        {loading ? <AutomaticRefreshIndicator testID="card-board-expanded-auto-progress" style={{ top: 0, right: 0 }} /> : null}
        <FolderWorkspaceReadOverlay host="board" />
      </View></GestureHandlerRootView>
    </AppModalSurface> : null}
  </View>;
});
