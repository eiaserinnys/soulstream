import { useMemo, useRef } from 'react';
import type { SessionEvent } from '../../api/types';
import type { StreamingSlots } from '../../store/chatStore';
import type { PersistentDisplayProjectionSettings } from './groupChatEvents';
import {
  groupChatEvents,
  hasActiveStreamingAssistantText,
  placePendingOptimistic,
  streamingSlotRenderItems,
  type ChatRenderItem,
} from './groupChatEvents';
import { replaceEqualDeep } from '../../lib/structural-sharing';
import { bottomFollowTargetKey } from './bottomFollow';
import { projectPersistentTurnUsage } from './persistentTurnUsageProjection';

const TYPING_RENDER_ITEM: ChatRenderItem = {
  kind: 'typing',
  key: 'typing-indicator',
};

interface Args {
  events: SessionEvent[];
  pendingOptimistic: SessionEvent | undefined;
  streamingSlots: StreamingSlots | undefined;
  sessionStatus: string | undefined;
  persistentDisplaySettings?: PersistentDisplayProjectionSettings;
  presentation?: 'default' | 'manuscript';
  showTurnUsage?: boolean;
}

export function useChatRenderItems({
  events,
  pendingOptimistic,
  streamingSlots,
  sessionStatus,
  persistentDisplaySettings,
  presentation = 'default',
  showTurnUsage,
}: Args): {
  reversedItems: ChatRenderItem[];
  bottomFollowItemKey: string | null;
} {
  const snapshotStreams = streamingSlots?.assistantSnapshotStreams;
  const baseRenderItems = useMemo<ChatRenderItem[]>(
    () => {
      const grouped = groupChatEvents(events, snapshotStreams, persistentDisplaySettings);
      const presented = presentation === 'manuscript'
        ? projectPersistentTurnUsage(grouped, events, showTurnUsage !== false)
        : grouped;
      return placePendingOptimistic(presented, pendingOptimistic);
    },
    [events, pendingOptimistic, persistentDisplaySettings, presentation, showTurnUsage, snapshotStreams],
  );
  const baseReversedItems = useMemo(
    () => [...baseRenderItems].reverse(),
    [baseRenderItems],
  );
  const streamingRenderItems = useMemo(
    () => streamingSlotRenderItems(streamingSlots),
    [streamingSlots],
  );
  const hasStreamingAssistant = Boolean(
    streamingSlots?.assistant
    || Object.keys(streamingSlots?.assistantByStream ?? {}).length > 0,
  );
  const hasHistoricalStreamingAssistantText = useMemo(
    () => hasActiveStreamingAssistantText(events, snapshotStreams),
    [events, snapshotStreams],
  );
  const bottomRenderItems = useMemo<ChatRenderItem[]>(() => {
    const items = streamingRenderItems;
    if (
      sessionStatus !== 'running' ||
      hasStreamingAssistant ||
      hasHistoricalStreamingAssistantText
    ) {
      return items;
    }
    return [...items, TYPING_RENDER_ITEM];
  }, [
    hasHistoricalStreamingAssistantText,
    hasStreamingAssistant,
    sessionStatus,
    streamingRenderItems,
  ]);
  const bottomReversedItems = useMemo(
    () => [...bottomRenderItems].reverse(),
    [bottomRenderItems],
  );
  const incomingReversedItems = useMemo(
    () =>
      bottomReversedItems.length > 0
        ? bottomReversedItems.concat(baseReversedItems)
        : baseReversedItems,
    [baseReversedItems, bottomReversedItems],
  );
  // Match by the existing render key, so prepend/append and streaming insertion
  // preserve row identities too. This is only the previous projection, not a store/index.
  const previousItems = useRef<ChatRenderItem[]>([]);
  const reversedItems = useMemo(() => {
    const previousByKey = new Map(previousItems.current.map(item => [item.key, item]));
    const shared = incomingReversedItems.map(item => {
      const previous = previousByKey.get(item.key);
      return previous === undefined ? item : replaceEqualDeep(previous, item);
    });
    const result = shared.length === previousItems.current.length
      && shared.every((item, index) => item === previousItems.current[index])
      ? previousItems.current : shared;
    previousItems.current = result;
    return result;
  }, [incomingReversedItems]);
  const bottomFollowItemKey =
    bottomFollowTargetKey(bottomRenderItems) ??
    bottomFollowTargetKey(baseRenderItems);

  return { reversedItems, bottomFollowItemKey };
}
