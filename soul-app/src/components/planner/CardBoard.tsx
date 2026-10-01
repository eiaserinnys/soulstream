import React, { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardDto, CardStatus } from '../../api/cardTypes';
import { useDeviceType, useTokens } from '../../theme';
import { GlassButton } from '../GlassSurface';
import { PostItCard } from './PostItCard';
import { createPostItRoles } from '../../theme/postItRoles';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { BoardDragCard, type BoardDragEvent } from './BoardDragCard';
import { CardStatusMenu } from './CardStatusMenu';
import { useCardTransition } from '../../hooks/useCardTransition';
import { boardVisibleColumns, boardDropStatus, boardLaneGeometry, boardLaneOffset, boardSnapOffsets, boardNearestLane, type BoardFrame, type BoardPosition } from '../../lib/card-board-layout';
export { BOARD_COLUMNS } from '../../lib/card-board-layout';

/** Compact paper owns size; lanes own peek and snap. Detail reads only follow explicit actions. */
export function CardBoard({ api, cards, onOpen, includeCompleted = true,
  phone: controlledPhone, initialPosition, onPositionChange }: {
  api: ApiClient | null; cards: readonly CardDto[]; onOpen(id: string): void;
  includeCompleted?: boolean;
  phone?: boolean; initialPosition?: BoardPosition; onPositionChange?(position: BoardPosition): void;
}) {
  const t = useTokens();
  const devicePhone = useDeviceType() === 'phone';
  const phone = controlledPhone ?? devicePhone;
  const window = useWindowDimensions();
  const columns = boardVisibleColumns(includeCompleted);
  const paper = createPostItRoles(t, 'compact');
  const frameRef = useRef<View>(null);
  const scroll = useRef<ScrollView>(null);
  const [frame, setFrame] = useState<BoardFrame>({ x: 0, y: 0, width: 0, height: 0 });
  const viewport = frame.width || window.width;
  const geometry = boardLaneGeometry(viewport, paper.width, t.uiSpacing.sm, phone);
  const offsets = columns.map((_, index) => boardLaneOffset(index, viewport, geometry, columns.length));
  const firstPosition = useRef(initialPosition ?? { x: phone ? offsets[4] : 0, lane: phone ? 'review' as const : 'todo' as const, lanes: {} });
  const initialContentOffset = useRef({ x: firstPosition.current.x, y: 0 });
  const previousLayout = useRef({ stride: geometry.stride, viewport, includeCompleted });
  const initialized = useRef(false);
  useEffect(() => {
    if (frame.width > 0 && !initialized.current) {
      initialized.current = true;
      position.current.x = initialPosition ? Math.min(initialPosition.x, offsets[offsets.length - 1]) : phone ? offsets[4] : 0;
      scroll.current?.scrollTo({ x: position.current.x, animated: false });
      onPositionChange?.({ ...position.current, lanes: { ...position.current.lanes } });
    } else if (initialized.current && (previousLayout.current.stride !== geometry.stride
      || previousLayout.current.viewport !== viewport || previousLayout.current.includeCompleted !== includeCompleted)) {
      // Visibility/font/viewport changes keep the same lane; hidden done returns to review.
      const lane = columns.findIndex(([status]) => status === position.current.lane);
      const index = lane < 0 ? columns.length - 1 : lane;
      position.current.lane = columns[index][0];
      position.current.x = offsets[index];
      scroll.current?.scrollTo({ x: position.current.x, animated: false });
      onPositionChange?.({ ...position.current, lanes: { ...position.current.lanes } });
    }
    previousLayout.current = { stride: geometry.stride, viewport, includeCompleted };
  }, [frame.width, geometry.stride, viewport, includeCompleted]);
  const position = useRef<BoardPosition>({ ...firstPosition.current, lanes: { ...firstPosition.current.lanes } });
  const geometryRef = useRef(geometry); geometryRef.current = geometry;
  const columnsRef = useRef(columns); columnsRef.current = columns;
  const offsetsRef = useRef(offsets); offsetsRef.current = offsets;
  const frameLatest = useRef(frame); frameLatest.current = frame;
  const [drag, setDrag] = useState<{ card: CardDto; event: BoardDragEvent; grabX: number; grabY: number } | null>(null);
  const dragRef = useRef(drag); dragRef.current = drag;
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [menu, setMenu] = useState<{ card: CardDto; target?: CardStatus } | null>(null);
  const stageHeight = useRef(0);
  const action = useCardTransition(api, drag?.card.id ?? '');
  const active = cards.filter((card) => !card.archived && card.status !== 'cancelled');
  const savePosition = () => onPositionChange?.({ ...position.current, lanes: { ...position.current.lanes } });
  const moveTo = (x: number, animated: boolean) => {
    const max = offsetsRef.current[offsetsRef.current.length - 1];
    const bounded = Math.max(0, Math.min(max, x));
    position.current.x = bounded;
    position.current.lane = columnsRef.current[boardNearestLane(bounded, offsetsRef.current)][0];
    scroll.current?.scrollTo({ x: bounded, animated }); savePosition();
  };
  const stopEdge = () => { if (edgeTimer.current) clearInterval(edgeTimer.current); edgeTimer.current = null; };
  useEffect(() => () => { stopEdge(); }, []);
  const start = (card: CardDto, event: BoardDragEvent) => {
    const value = { card, event, grabX: event.x, grabY: event.y }; dragRef.current = value; setDrag(value);
    stopEdge();
    edgeTimer.current = setInterval(() => {
      const current = dragRef.current; if (!current) return;
      const f = frameLatest.current;
      const x = current.event.absoluteX - f.x;
      const direction = x < t.hitTarget.min ? -1 : x > f.width - t.hitTarget.min ? 1 : 0;
      if (direction) moveTo(position.current.x + direction * t.uiSpacing.lg, false);
    }, 80);
  };
  const finish = () => {
    stopEdge(); dragRef.current = null; setDrag(null);
    if (phone) moveTo(offsetsRef.current[boardNearestLane(position.current.x, offsetsRef.current)], true);
  };
  const drop = (card: CardDto, event: BoardDragEvent) => {
    const boardFrame = { ...frameLatest.current, y: frameLatest.current.y + stageHeight.current, height: frameLatest.current.height - stageHeight.current };
    const next = boardDropStatus(event.absoluteX, event.absoluteY, boardFrame, geometryRef.current, position.current.x, card.status, columnsRef.current);
    if (!next) { Alert.alert('카드 이동 취소', '다른 단계의 레인 위에서 놓아 주세요.'); return; }
    if (card.status === 'review' && next === 'running') { setMenu({ card, target: next }); return; }
    void action.transition(card, next);
  };
  return <View ref={frameRef} testID="card-board-frame" style={{ flex: 1 }} onLayout={(event) => {
    const { width, height } = event.nativeEvent.layout;
    setFrame((old) => ({ ...old, width, height }));
    frameRef.current?.measureInWindow((x, y) => setFrame({ x, y, width, height }));
  }}>
    {phone ? <ScrollView horizontal testID="card-board-stages" showsHorizontalScrollIndicator={false}
      onLayout={(event) => { stageHeight.current = event.nativeEvent.layout.height; }}
      style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: t.cardLayout.padding, gap: t.uiSpacing.xs }}>
      {columns.map(([status, label], index) => <GlassButton key={status} accessibilityLabel={`${label} 레인 보기`}
        disabled={!!drag} onPress={() => moveTo(offsets[index], true)}><Text style={{ ...t.foundation.typography.meta, color: t.colors.textPrimary }}>{label}</Text></GlassButton>)}
    </ScrollView> : null}
    <ScrollView ref={scroll} horizontal testID="card-board" style={{ flex: 1 }} showsHorizontalScrollIndicator={false}
      scrollEnabled={!drag} snapToOffsets={phone ? boardSnapOffsets(viewport, geometry, columns.length) : undefined} decelerationRate={phone ? 'fast' : 'normal'}
      disableIntervalMomentum={phone} contentOffset={initialContentOffset.current} scrollEventThrottle={16}
      onScroll={(event) => { position.current.x = event.nativeEvent.contentOffset.x;
        position.current.lane = columns[boardNearestLane(position.current.x, offsets)][0]; savePosition(); }}
      contentContainerStyle={{ gap: geometry.gap, paddingHorizontal: geometry.inset, alignItems: 'stretch', paddingTop: t.uiSpacing.sm }}>
      {columns.map(([status, label]) => {
        const items = active.filter((card) => card.status === status);
        return <View key={status} testID={`card-board-column-${status}`} style={{ width: geometry.laneWidth, flexShrink: 0, gap: t.uiSpacing.sm }}>
          <View style={{ paddingHorizontal: t.uiSpacing.sm, minHeight: t.foundation.typography.section.lineHeight }}>
            <PlannerSectionHeader variant={phone ? 'lane' : 'board'} title={label} count={items.length}
              testID={phone ? `card-board-lane-heading-${status}` : undefined} countTestID={`card-board-count-${status}`} />
          </View>
          <ScrollView testID={`card-board-scroll-${status}`} scrollEnabled={!drag} style={{ flex: 1 }} showsVerticalScrollIndicator={false}
            contentOffset={{ x: 0, y: firstPosition.current.lanes[status] ?? 0 }} scrollEventThrottle={16}
            onScroll={(event) => { position.current.lanes[status] = event.nativeEvent.contentOffset.y; savePosition(); }}
            contentContainerStyle={{ gap: t.cardLayout.gap, paddingHorizontal: t.uiSpacing.sm, paddingTop: t.uiSpacing.xs, paddingBottom: t.cardLayout.padding }}>
            {items.length ? items.map((card) => <BoardDragCard key={card.id} api={api} card={card}
              dragging={drag?.card.id === card.id} onOpen={() => onOpen(card.id)} onMenu={() => setMenu({ card })}
              onStart={(event) => start(card, event)} onMove={(event) => { if (dragRef.current) { const value = { ...dragRef.current, event }; dragRef.current = value; setDrag(value); } }}
              onDrop={(event) => drop(card, event)} onFinish={finish} />)
              : <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>카드가 없습니다.</Text>}
          </ScrollView>
        </View>;
      })}
    </ScrollView>
    {drag ? <View testID="card-board-drag-preview" pointerEvents="none" style={{ position: 'absolute', zIndex: 1,
      left: drag.event.absoluteX - drag.grabX - frame.x, top: drag.event.absoluteY - drag.grabY - frame.y }}>
      <PostItCard api={null} card={drag.card} variant="compact" onOpen={() => {}} />
    </View> : null}
    {menu ? <CardStatusMenu api={api} card={menu.card} initialTarget={menu.target} onClose={() => setMenu(null)} /> : null}
  </View>;
}
