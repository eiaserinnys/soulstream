import React, { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
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
import { BOARD_COLUMNS, boardDropStatus, boardLaneGeometry, type BoardFrame, type BoardPosition } from '../../lib/card-board-layout';
export { BOARD_COLUMNS } from '../../lib/card-board-layout';

/** Compact paper owns size; lanes own peek and snap. Detail reads only follow explicit actions. */
export function CardBoard({ api, cards, onOpen, includeCompleted = true, onIncludeCompletedChange, global = false,
  phone: controlledPhone, initialPosition, onPositionChange }: {
  api: ApiClient | null; cards: readonly CardDto[]; onOpen(id: string): void;
  includeCompleted?: boolean; onIncludeCompletedChange?(value: boolean): void; global?: boolean;
  phone?: boolean; initialPosition?: BoardPosition; onPositionChange?(position: BoardPosition): void;
}) {
  const t = useTokens();
  const devicePhone = useDeviceType() === 'phone';
  const phone = controlledPhone ?? devicePhone;
  const paper = createPostItRoles(t, 'compact');
  const frameRef = useRef<View>(null);
  const scroll = useRef<ScrollView>(null);
  const [frame, setFrame] = useState<BoardFrame>({ x: 0, y: 0, width: 0, height: 0 });
  const geometry = boardLaneGeometry(frame.width, paper.width, t.uiSpacing.sm, phone);
  const firstPosition = useRef(initialPosition ?? { x: phone ? geometry.stride * 4 : 0, lanes: {} });
  const initialContentOffset = useRef({ x: firstPosition.current.x, y: 0 });
  const previousStride = useRef(geometry.stride);
  const initialized = useRef(false);
  useEffect(() => {
    if (frame.width > 0 && !initialized.current) {
      initialized.current = true;
      scroll.current?.scrollTo({ x: firstPosition.current.x, animated: false });
    } else if (initialized.current && previousStride.current !== geometry.stride) {
      // Font changes resize paper. Keep the user's selected lane, rather than reset to review.
      const lane = Math.round(position.current.x / previousStride.current);
      position.current.x = lane * geometry.stride;
      scroll.current?.scrollTo({ x: position.current.x, animated: false });
      onPositionChange?.({ ...position.current, lanes: { ...position.current.lanes } });
    }
    previousStride.current = geometry.stride;
  }, [frame.width, geometry.stride]);
  const position = useRef<BoardPosition>({ ...firstPosition.current, lanes: { ...firstPosition.current.lanes } });
  const geometryRef = useRef(geometry); geometryRef.current = geometry;
  const frameLatest = useRef(frame); frameLatest.current = frame;
  const [drag, setDrag] = useState<{ card: CardDto; event: BoardDragEvent; grabX: number; grabY: number } | null>(null);
  const dragRef = useRef(drag); dragRef.current = drag;
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [menu, setMenu] = useState<{ card: CardDto; target?: CardStatus } | null>(null);
  const stageHeight = useRef(0);
  const action = useCardTransition(api, drag?.card.id ?? '');
  const active = cards.filter((card) => !card.archived && card.status !== 'cancelled');
  const savePosition = () => onPositionChange?.({ x: position.current.x, lanes: { ...position.current.lanes } });
  const moveTo = (x: number, animated: boolean) => {
    const g = geometryRef.current;
    const max = g.laneWidth * BOARD_COLUMNS.length + g.gap * (BOARD_COLUMNS.length - 1) + g.inset * 2 - frameLatest.current.width;
    const bounded = Math.max(0, Math.min(max, x));
    position.current.x = bounded;
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
    if (phone) moveTo(Math.round(position.current.x / geometryRef.current.stride) * geometryRef.current.stride, true);
  };
  const drop = (card: CardDto, event: BoardDragEvent) => {
    const boardFrame = { ...frameLatest.current, y: frameLatest.current.y + stageHeight.current, height: frameLatest.current.height - stageHeight.current };
    const next = boardDropStatus(event.absoluteX, event.absoluteY, boardFrame, geometryRef.current, position.current.x, card.status);
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
      {BOARD_COLUMNS.map(([status, label], index) => <GlassButton key={status} accessibilityLabel={`${label} 레인 보기`}
        disabled={!!drag} onPress={() => moveTo(index * geometry.stride, true)}><Text style={{ ...t.foundation.typography.meta, color: t.colors.textPrimary }}>{label}</Text></GlassButton>)}
    </ScrollView> : null}
    <ScrollView ref={scroll} horizontal testID="card-board" style={{ flex: 1 }} showsHorizontalScrollIndicator={false}
      scrollEnabled={!drag} snapToInterval={phone ? geometry.stride : undefined} decelerationRate={phone ? 'fast' : 'normal'}
      disableIntervalMomentum={phone} contentOffset={initialContentOffset.current} scrollEventThrottle={16}
      onScroll={(event) => { position.current.x = event.nativeEvent.contentOffset.x; savePosition(); }}
      contentContainerStyle={{ gap: geometry.gap, paddingHorizontal: geometry.inset, alignItems: 'stretch', paddingTop: t.uiSpacing.sm }}>
      {BOARD_COLUMNS.map(([status, label]) => {
        const items = active.filter((card) => card.status === status);
        const hidden = status === 'done' && !global && !includeCompleted;
        return <View key={status} testID={`card-board-column-${status}`} style={{ width: geometry.laneWidth, flexShrink: 0, gap: t.uiSpacing.sm }}>
          <View style={{ paddingHorizontal: t.uiSpacing.sm, minHeight: t.foundation.typography.section.lineHeight }}>
            <PlannerSectionHeader variant={phone ? 'lane' : 'board'} title={label} count={items.length}
              testID={phone ? `card-board-lane-heading-${status}` : undefined} countTestID={`card-board-count-${status}`} />
          </View>
          <ScrollView testID={`card-board-scroll-${status}`} scrollEnabled={!drag} style={{ flex: 1 }} showsVerticalScrollIndicator={false}
            contentOffset={{ x: 0, y: firstPosition.current.lanes[status] ?? 0 }} scrollEventThrottle={16}
            onScroll={(event) => { position.current.lanes[status] = event.nativeEvent.contentOffset.y; savePosition(); }}
            contentContainerStyle={{ gap: t.cardLayout.gap, paddingHorizontal: t.uiSpacing.sm, paddingTop: t.uiSpacing.xs, paddingBottom: t.cardLayout.padding }}>
            {hidden && items.length ? <View style={{ gap: t.uiSpacing.md }}>
              <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>완료 {items.length}개 숨김</Text>
              {onIncludeCompletedChange ? <GlassButton accessibilityLabel="숨긴 완료 카드 보기" onPress={() => onIncludeCompletedChange(true)}>
                <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>완료 포함</Text>
              </GlassButton> : null}
            </View> : items.length && !hidden ? items.map((card) => <BoardDragCard key={card.id} api={api} card={card}
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
