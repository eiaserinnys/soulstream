import React, { useMemo, useRef } from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import { BOARD_DRAG_SLOP, BOARD_LONG_PRESS_MS } from '../../lib/card-board-layout';
import { useCardTransition } from '../../hooks/useCardTransition';
import { PostItCard, type PostItCardHandle } from './PostItCard';

export type BoardDragEvent = { absoluteX: number; absoluteY: number; x: number; y: number; translationX: number; translationY: number };
export function BoardDragCard(props: {
  api: ApiClient | null; card: CardDto; dragging: boolean; onOpen(target?: number): void; canPress?(): boolean;
  onStart(event: BoardDragEvent): void; onMove(event: BoardDragEvent): void;
  onDrop(event: BoardDragEvent): void; onFinish(): void;
}) {
  const latest = useRef(props); latest.current = props;
  const suppressUntil = useRef(0);
  const secondaryDown = useRef(false);
  const suppressWebContext = useRef(false);
  const pendingContextMenu = useRef(false);
  const cardRef = useRef<PostItCardHandle>(null);
  const { pending } = useCardTransition(props.api, props.card.id);
  const canOpenContextMenu = () => latest.current.canPress?.() ?? true;
  const canPress = () => Date.now() >= suppressUntil.current && canOpenContextMenu();
  const openContextMenu = () => {
    if (canOpenContextMenu()) cardRef.current?.openContextMenu();
  };
  const gesture = useMemo(() => Gesture.Pan().withTestId(`board-drag-${props.card.id}`)
    .enabled(!!props.api && !pending).failOffsetX([-BOARD_DRAG_SLOP, BOARD_DRAG_SLOP])
    .failOffsetY([-BOARD_DRAG_SLOP, BOARD_DRAG_SLOP]).activateAfterLongPress(BOARD_LONG_PRESS_MS).runOnJS(true)
    .onStart((event) => {
      if (secondaryDown.current || Date.now() < suppressUntil.current) return;
      suppressUntil.current = Infinity; latest.current.onStart(event);
    })
    .onUpdate((event) => { if (suppressUntil.current === Infinity) latest.current.onMove(event); })
    .onEnd((event, success) => {
      if (!success || suppressUntil.current !== Infinity) return;
      if (Math.hypot(event.translationX, event.translationY) > BOARD_DRAG_SLOP) latest.current.onDrop(event);
      else pendingContextMenu.current = true;
    })
    .onFinalize(() => {
      const shouldOpenContextMenu = pendingContextMenu.current;
      pendingContextMenu.current = false;
      if (suppressUntil.current === Infinity) {
        suppressUntil.current = Date.now() + BOARD_LONG_PRESS_MS;
        latest.current.onFinish();
        if (shouldOpenContextMenu) requestAnimationFrame(openContextMenu);
      }
    }),
  [props.card.id, props.api, pending]);
  const open = (target?: number) => { if (Date.now() >= suppressUntil.current) props.onOpen(target); };
  const menu = () => { if (canPress()) openContextMenu(); };
  // RN 0.86 pointer delivery is gated by RCTGetDispatchW3CPointerEvents on iOS.
  // withNativePointerEvents enables this path before the first React surface.
  const secondary: ViewProps = { onPointerDown: (event) => {
    if (event.nativeEvent.button === 2 && !secondaryDown.current) {
      secondaryDown.current = true;
    }
  }, onPointerUp: () => {
    if (secondaryDown.current) {
      secondaryDown.current = false;
      suppressUntil.current = Date.now() + BOARD_LONG_PRESS_MS;
      suppressWebContext.current = true;
      openContextMenu();
      requestAnimationFrame(() => { suppressWebContext.current = false; });
    }
  }, onPointerCancel: () => {
    secondaryDown.current = false;
    pendingContextMenu.current = false;
    if (suppressUntil.current === Infinity) {
      suppressUntil.current = Date.now() + BOARD_LONG_PRESS_MS; latest.current.onFinish();
    }
  } };
  const webContext = Platform.OS === 'web' ? {
    onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); if (!suppressWebContext.current) menu(); },
    onKeyDown: (event: { key: string; shiftKey: boolean; preventDefault(): void }) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { event.preventDefault(); menu(); }
    },
  } : {};
  return <GestureDetector gesture={gesture} touchAction="auto"><View testID={`board-card-gesture-${props.card.id}`} collapsable={false} {...secondary} {...webContext}
    accessibilityActions={[{ name: 'showMenu', label: '카드 메뉴' }]}
    onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'showMenu') menu(); }} style={{ opacity: props.dragging ? 0.35 : 1 }}>
    <PostItCard ref={cardRef} api={props.api} card={props.card} variant="compact" boardManaged
      canPress={canPress} canOpenContextMenu={canOpenContextMenu} onOpen={open} />
  </View></GestureDetector>;
}
