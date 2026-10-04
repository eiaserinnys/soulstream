import {CardTransitionSettings} from './CardTransitionSettings';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, FlatList, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import { useDeviceType, useTokens } from '../../theme';
import { PostItCard } from './PostItCard';
import { createPostItRoles } from '../../theme/postItRoles';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { BoardDragCard, type BoardDragEvent } from './BoardDragCard';
import { CardStatusMenu } from './CardStatusMenu';
import { useBoardPointerPan } from './useBoardPointerPan';
import { useCardTransition } from '../../hooks/useCardTransition';
import type { CompletedBrowser } from '../../hooks/useCompletedCards';
import { CompletedCardFilters } from './CompletedCardFilters';
import { boardVisibleColumns, boardDropStatus, boardLaneGeometry, boardLaneOffset, boardSnapOffsets, boardNearestLane, type BoardFrame, type BoardPosition } from '../../lib/card-board-layout';
export { BOARD_COLUMNS } from '../../lib/card-board-layout';

/** Compact paper owns size; lanes own peek and snap. Detail reads only follow explicit actions. */
export function CardBoard({ api, cards, onOpen, includeCompleted = true,
  phone: controlledPhone, initialPosition, onPositionChange,completed, bottomInset = 0, hideEmptyLanes = false }: {
  api: ApiClient | null; cards: readonly CardDto[]; onOpen(id: string, target?: number): void;
  includeCompleted?: boolean;
  phone?: boolean; initialPosition?: BoardPosition; onPositionChange?(position: BoardPosition): void; hideEmptyLanes?: boolean;
  completed?:CompletedBrowser;
  bottomInset?: number;
}) {
  const t = useTokens();
  const devicePhone = useDeviceType() === 'phone';
  const phone = controlledPhone ?? devicePhone;
  const window = useWindowDimensions();
  const active = cards.filter((card) => !card.archived);
  const visibleColumns = boardVisibleColumns(includeCompleted);
  const columns = hideEmptyLanes
    ? visibleColumns.filter(([status]) => active.some((card) => card.status === status))
    : visibleColumns;
  const paper = createPostItRoles(t, 'compact');
  const frameRef = useRef<View>(null);
  const scroll = useRef<ScrollView>(null);
  const [frame, setFrame] = useState<BoardFrame>({ x: 0, y: 0, width: 0, height: 0 });
  const viewport = frame.width || window.width;
  const geometry = boardLaneGeometry(viewport, paper.width, t.uiSpacing.sm, phone,columns,paper.gap);
  const offsets = columns.map((_, index) => boardLaneOffset(index, viewport, geometry, columns.length));
  const preferredLane = columns.findIndex(([status]) => status === 'review');
  const defaultLaneIndex = preferredLane >= 0 ? preferredLane : columns.length ? 0 : -1;
  const laneSignature = columns.map(([status]) => status).join(',');
  const nearestVisibleLane = (status?: BoardPosition['lane']) => {
    if (columns.length === 0) return -1;
    const exact = columns.findIndex(([candidate]) => candidate === status);
    if (exact >= 0) return exact;
    if (!status) return defaultLaneIndex;
    const order = boardVisibleColumns(true).map(([candidate]) => candidate);
    const previousOrder = order.indexOf(status);
    return columns.reduce((nearest, [candidate], index) => {
      const distance = Math.abs(order.indexOf(candidate) - previousOrder);
      const nearestDistance = Math.abs(order.indexOf(columns[nearest][0]) - previousOrder);
      return distance < nearestDistance ? index : nearest;
    }, 0);
  };
  const restoreX = (saved: BoardPosition) => {
    const lane = nearestVisibleLane(saved.lane);
    return lane >= 0 ? offsets[lane] ?? 0 : 0;
  };
  const initialPositionValue = initialPosition
    ? { ...initialPosition, lanes: { ...initialPosition.lanes } }
    : { x: offsets[defaultLaneIndex] ?? 0, lane: defaultLaneIndex >= 0 ? columns[defaultLaneIndex][0] : undefined, lanes: {} };
  const position = useRef<BoardPosition>(initialPositionValue);
  const initialContentOffset = useRef({ x: restoreX(position.current), y: 0 });
  const previousLayout = useRef({ stride: geometry.stride, viewport, includeCompleted, laneSignature, hideEmptyLanes });
  const initialized = useRef(false);
  const completedList=useRef<FlatList<CardDto>>(null);
  const laneScrolls = useRef<Partial<Record<CardDto['status'], ScrollView | null>>>({});
  const savePosition = () => onPositionChange?.({ ...position.current, lanes: { ...position.current.lanes } });
  useEffect(() => {
    if (frame.width > 0 && !initialized.current) {
      initialized.current = true;
      const lane = nearestVisibleLane(position.current.lane);
      position.current.lane = lane >= 0 ? columns[lane][0] : undefined;
      position.current.x = lane >= 0 ? offsets[lane] ?? 0 : 0;
      scroll.current?.scrollTo({ x: position.current.x, animated: false });
      savePosition();
    } else if (initialized.current && (previousLayout.current.stride !== geometry.stride
      || previousLayout.current.viewport !== viewport || previousLayout.current.includeCompleted !== includeCompleted
      || previousLayout.current.laneSignature !== laneSignature || previousLayout.current.hideEmptyLanes !== hideEmptyLanes)) {
      const index = nearestVisibleLane(position.current.lane);
      position.current.lane = index >= 0 ? columns[index][0] : undefined;
      position.current.x = index >= 0 ? offsets[index] ?? 0 : 0;
      scroll.current?.scrollTo({ x: position.current.x, animated: false });
      savePosition();
    }
    previousLayout.current = { stride: geometry.stride, viewport, includeCompleted, laneSignature, hideEmptyLanes };
  }, [frame.width, geometry.stride, viewport, includeCompleted, laneSignature, hideEmptyLanes]);
  const lastIncomingPosition = useRef(initialPosition);
  useEffect(() => {
    if (!initialPosition || initialized.current && initialPosition === lastIncomingPosition.current) return;
    lastIncomingPosition.current = initialPosition;
    if (!initialized.current) return;
    position.current.lanes = { ...initialPosition.lanes };
    const lane = nearestVisibleLane(initialPosition.lane);
    position.current.lane = lane >= 0 ? columns[lane][0] : undefined;
    position.current.x = lane >= 0 ? offsets[lane] ?? 0 : 0;
    scroll.current?.scrollTo({ x: position.current.x, animated: false });
    for (const [status, scrollView] of Object.entries(laneScrolls.current) as [CardDto['status'], ScrollView | null][]) {
      const y = position.current.lanes[status] ?? 0;
      scrollView?.scrollTo({ y, animated: false });
    }
    completedList.current?.scrollToOffset({ offset: position.current.lanes.done ?? 0, animated: false });
    savePosition();
  }, [initialPosition]);
  const geometryRef = useRef(geometry); geometryRef.current = geometry;
  const columnsRef = useRef(columns); columnsRef.current = columns;
  const offsetsRef = useRef(offsets); offsetsRef.current = offsets;
  const frameLatest = useRef(frame); frameLatest.current = frame;
  const [drag, setDrag] = useState<{ card: CardDto; event: BoardDragEvent; grabX: number; grabY: number } | null>(null);
  const dragRef = useRef(drag); dragRef.current = drag;
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [menu, setMenu] = useState<{ card: CardDto; } | null>(null);
  useEffect(()=>{completedList.current?.scrollToOffset({offset:0,animated:false});},[completed?.resetKey]);
  const action = useCardTransition(api, drag?.card.id ?? '');
  const moveTo = (x: number, animated: boolean) => {
    if (offsetsRef.current.length === 0) return;
    const max = offsetsRef.current[offsetsRef.current.length - 1] ?? 0;
    const bounded = Math.max(0, Math.min(max, x));
    const lane = boardNearestLane(bounded, offsetsRef.current);
    const status = columnsRef.current[lane]?.[0];
    if (!status) return;
    position.current.x = bounded;
    position.current.lane = status;
    scroll.current?.scrollTo({ x: bounded, animated }); savePosition();
  };
  const pan = useBoardPointerPan({ getX: () => position.current.x, max: offsets[offsets.length - 1] ?? 0, dragging: !!drag, move: (x) => moveTo(x, false) });
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
    if (phone && offsetsRef.current.length) moveTo(offsetsRef.current[boardNearestLane(position.current.x, offsetsRef.current)], true);
  };
  const drop = (card: CardDto, event: BoardDragEvent) => {
    const boardFrame = frameLatest.current;
    const next = boardDropStatus(event.absoluteX, event.absoluteY, boardFrame, geometryRef.current, position.current.x, card.status, columnsRef.current);
    if (!next) { Alert.alert('카드 이동 취소', '다른 단계의 레인 위에서 놓아 주세요.'); return; }
    void action.transition(card, next);
  };
  return <View ref={frameRef} {...pan.handlers} testID="card-board-frame" style={{ flex: 1 }} onLayout={(event) => {
    const { width, height } = event.nativeEvent.layout;
    setFrame((old) => ({ ...old, width, height }));
    frameRef.current?.measureInWindow((x, y) => setFrame({ x, y, width, height }));
  }}>
    <CardTransitionSettings api={api} action={action}/>
    <ScrollView ref={scroll} horizontal testID="card-board" style={{ flex: 1 }} showsHorizontalScrollIndicator={false}
      scrollEnabled={!drag} snapToOffsets={phone ? boardSnapOffsets(viewport, geometry, columns.length) : undefined} decelerationRate={phone ? 'fast' : 'normal'}
      disableIntervalMomentum={phone} contentOffset={initialContentOffset.current} scrollEventThrottle={16}
      onScroll={(event) => { position.current.x = columns.length ? event.nativeEvent.contentOffset.x : 0;
        const lane = columns.length ? boardNearestLane(position.current.x, offsets) : -1;
        position.current.lane = lane >= 0 ? columns[lane]?.[0] : undefined; savePosition(); }}
      contentContainerStyle={{ gap: geometry.gap, paddingHorizontal: geometry.inset, alignItems: 'stretch' }}>
      {hideEmptyLanes && columns.length === 0 ? <View testID="card-board-empty" style={{ paddingHorizontal: t.uiSpacing.sm, paddingTop: t.uiSpacing.xs }}>
        <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>카드가 없습니다.</Text>
      </View> : null}
      {columns.map(([status, label],laneIndex) => {
        const items = active.filter((card) => card.status === status);
        const renderItem=(card:CardDto)=><BoardDragCard api={api} card={card}
          dragging={drag?.card.id === card.id} onOpen={(target)=>{if(pan.canPress()){if(target===undefined)onOpen(card.id);else onOpen(card.id,target);}}}
          onMenu={()=>{if(pan.canPress())setMenu({card});}} onStart={event=>start(card,event)}
          onMove={event=>{if(dragRef.current){const value={...dragRef.current,event};dragRef.current=value;setDrag(value);}}}
          onDrop={event=>drop(card,event)} onFinish={finish}/>;
        return <View key={status} testID={`card-board-column-${status}`} style={{ width: geometry.lanes[laneIndex].width, flexShrink: 0, gap: t.uiSpacing.sm }}>
          <View style={{ paddingHorizontal: t.uiSpacing.sm, minHeight: t.hitTarget.min, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.xs }}>
            <PlannerSectionHeader variant={status === 'todo' || phone ? 'lane' : 'board'} title={label} count={items.length} countSuffix={status==='done'?'개 표시':undefined}
              testID={phone ? `card-board-lane-heading-${status}` : undefined} countTestID={`card-board-count-${status}`} />
          </View>
          {status==='done'?<>
            {completed?<View style={{paddingHorizontal:t.uiSpacing.sm}}><CompletedCardFilters browser={completed}/></View>:null}
            <FlatList ref={completedList} key={geometry.completedColumns} testID="card-board-scroll-done" style={{flex:1}}
              data={items} numColumns={geometry.completedColumns} keyExtractor={card=>card.id} renderItem={({item})=><View style={{width:paper.width,marginBottom:paper.gap}}>{renderItem(item)}</View>}
              columnWrapperStyle={geometry.completedColumns>1?{gap:paper.gap}:undefined}
              contentContainerStyle={{paddingHorizontal:t.uiSpacing.sm,paddingTop:t.uiSpacing.xs,paddingBottom:t.cardLayout.padding + bottomInset}}
              windowSize={5} initialNumToRender={geometry.completedColumns*2} maxToRenderPerBatch={geometry.completedColumns*2}
              onEndReached={completed?.loadMore} onEndReachedThreshold={0.5} showsVerticalScrollIndicator={false} scrollEnabled={!drag}
              onScroll={event=>{position.current.lanes.done=event.nativeEvent.contentOffset.y;savePosition();}}
              ListEmptyComponent={<Text style={{...t.foundation.typography.body,color:t.colors.textSecondary}}>{completed?.loading?'완료 카드를 불러오는 중…':'선택한 기간에 완료 카드가 없습니다'}</Text>}/>
          </>:<ScrollView ref={value => { laneScrolls.current[status] = value; }} testID={`card-board-scroll-${status}`} scrollEnabled={!drag} style={{ flex: 1 }} showsVerticalScrollIndicator={false}
            contentOffset={{ x: 0, y: position.current.lanes[status] ?? 0 }} scrollEventThrottle={16}
            onScroll={(event) => { position.current.lanes[status] = event.nativeEvent.contentOffset.y; savePosition(); }}
            contentContainerStyle={{ gap: t.cardLayout.gap, paddingHorizontal: t.uiSpacing.sm, paddingTop: t.uiSpacing.xs, paddingBottom: t.cardLayout.padding + bottomInset }}>
            {items.length ? items.map((card) => <BoardDragCard key={card.id} api={api} card={card}
              dragging={drag?.card.id === card.id} onOpen={(target) => {
                if (!pan.canPress()) return;
                if (target === undefined) onOpen(card.id);
                else onOpen(card.id, target);
              }} onMenu={() => { if (pan.canPress()) setMenu({ card }); }}
              onStart={(event) => start(card, event)} onMove={(event) => { if (dragRef.current) { const value = { ...dragRef.current, event }; dragRef.current = value; setDrag(value); } }}
              onDrop={(event) => drop(card, event)} onFinish={finish} />)
              : <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>카드가 없습니다.</Text>}
          </ScrollView>}
        </View>;
      })}
    </ScrollView>
    {drag ? <View testID="card-board-drag-preview" pointerEvents="none" style={{ position: 'absolute', zIndex: 1,
      left: drag.event.absoluteX - drag.grabX - frame.x, top: drag.event.absoluteY - drag.grabY - frame.y }}>
      <PostItCard api={null} card={drag.card} variant="compact" onOpen={() => {}} />
    </View> : null}
    {menu ? <CardStatusMenu api={api} card={menu.card} onClose={() => setMenu(null)} /> : null}
  </View>;
}
