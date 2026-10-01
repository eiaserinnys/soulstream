import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import { queueAfterCardId } from '../../lib/card-presentation';
import { cardOperationId, useCardActions } from '../../hooks/useCardActions';
import { useTokens } from '../../theme';
import { CardRow } from './CardRow';

export function CardQueue({ api, cards, onOpen, onDragStateChange }: {
  api: ApiClient | null; cards: CardDto[]; onOpen(id: string): void; onDragStateChange(dragging: boolean): void;
}) {
  const t = useTokens();
  const [layouts, setLayouts] = useState<Record<string, { id: string; top: number; height: number }>>({});
  const { run, pending } = useCardActions(api);
  const drop = (id: string, y: number) => {
    const card = cards.find((row) => row.id === id);
    if (!api || !card) return;
    const after = queueAfterCardId(id, y, cards.flatMap((row) => layouts[row.id] ? [layouts[row.id]] : []));
    void run(() => api.reorderCardQueue(id, after, card.version, cardOperationId()));
  };
  return <View style={{ gap: t.cardLayout.gap }}>
    {cards.map((card, index) => <QueueRow queueIndex={index + 1} key={card.id} api={api} card={card} top={layouts[card.id]?.top ?? 0}
      enabled={!pending && cards.every((row) => !!layouts[row.id])} onOpen={() => onOpen(card.id)}
      onLayout={(top, height) => setLayouts((old) => old[card.id]?.top === top && old[card.id]?.height === height ? old : { ...old, [card.id]: { id: card.id, top, height } })}
      onDrop={drop} onDragStateChange={onDragStateChange} />)}
  </View>;
}

function QueueRow({ api, card, queueIndex, top, enabled, onOpen, onLayout, onDrop, onDragStateChange }: {
  api: ApiClient | null; card: CardDto; queueIndex: number; top: number; enabled: boolean; onOpen(): void;
  onLayout(top: number, height: number): void; onDrop(id: string, y: number): void; onDragStateChange(dragging: boolean): void;
}) {
  const offset = useSharedValue(0);
  const start = useSharedValue(0);
  const active = useSharedValue(false);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }], zIndex: active.value ? 1 : 0 }));
  // Same long-press gesture threshold as StarredFolderList.
  const gesture = useMemo(() => Gesture.Pan().enabled(enabled).activateAfterLongPress(350)
    .onStart((event) => { active.value = true; start.value = event.y; runOnJS(onDragStateChange)(true); })
    .onUpdate((event) => { offset.value = event.translationY; })
    .onEnd((event) => { if (Math.abs(event.translationY) > 8) runOnJS(onDrop)(card.id, top + start.value + event.translationY); })
    .onFinalize(() => { active.value = false; offset.value = 0; runOnJS(onDragStateChange)(false); }),
  [enabled, card.id, top, onDragStateChange, onDrop, active, start, offset]);
  return <Animated.View onLayout={(event) => onLayout(event.nativeEvent.layout.y, event.nativeEvent.layout.height)} style={style}>
    <GestureDetector gesture={gesture}><View collapsable={false}><CardRow today queueIndex={queueIndex} api={api} card={card} onOpen={onOpen} /></View></GestureDetector>
  </Animated.View>;
}
