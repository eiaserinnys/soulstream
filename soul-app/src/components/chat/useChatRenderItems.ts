import { useMemo } from 'react';
import type { SessionEvent } from '../../api/types';
import type { StreamingSlots } from '../../store/chatStore';
import {
  groupChatEvents,
  hasActiveStreamingAssistantText,
  placePendingOptimistic,
  streamingSlotRenderItems,
  type ChatRenderItem,
} from './groupChatEvents';
import { bottomFollowTargetKey } from './bottomFollow';

const TYPING_RENDER_ITEM: ChatRenderItem = {
  kind: 'typing',
  key: 'typing-indicator',
};

interface Args {
  events: SessionEvent[];
  pendingOptimistic: SessionEvent | undefined;
  streamingSlots: StreamingSlots | undefined;
  sessionStatus: string | undefined;
}

export function useChatRenderItems({
  events,
  pendingOptimistic,
  streamingSlots,
  sessionStatus,
}: Args): {
  reversedItems: ChatRenderItem[];
  bottomFollowItemKey: string | null;
} {
  const snapshotStreams = streamingSlots?.assistantSnapshotStreams;
  const baseRenderItems = useMemo<ChatRenderItem[]>(
    () => placePendingOptimistic(
      groupChatEvents(events, snapshotStreams),
      pendingOptimistic,
    ),
    [events, pendingOptimistic, snapshotStreams],
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
  const reversedItems = useMemo(
    () =>
      bottomReversedItems.length > 0
        ? bottomReversedItems.concat(baseReversedItems)
        : baseReversedItems,
    [baseReversedItems, bottomReversedItems],
  );
  const bottomFollowItemKey =
    bottomFollowTargetKey(bottomRenderItems) ??
    bottomFollowTargetKey(baseRenderItems);

  return { reversedItems, bottomFollowItemKey };
}
