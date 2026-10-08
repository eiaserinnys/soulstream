import { useMemo, useRef } from 'react';
import type { SessionEvent } from '../../api/types';
import type { PersistentTurnUsageMode } from '../../api/persistentSessionEndpoints';
import type { StreamingSlots } from '../../store/chatStore';
import type { PersistentDisplayProjectionSettings } from './groupChatEvents';
import {
  groupChatEvents,
  groupAgentUserUtterances,
  hasActiveStreamingAssistantText,
  placePendingOptimistic,
  streamingSlotRenderItems,
  type ChatRenderItem,
} from './groupChatEvents';
import { projectManuscriptActivity } from './manuscriptActivityProjection';
import { replaceEqualDeep } from '../../lib/structural-sharing';
import { bottomFollowTargetKey } from './bottomFollow';
import { projectPersistentTurnUsage } from './persistentTurnUsageProjection';
import { projectCacheKeepaliveTurns } from './cacheKeepaliveProjection';

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
  turnUsageMode?: PersistentTurnUsageMode;
}

export function useChatRenderItems({
  events,
  pendingOptimistic,
  streamingSlots,
  sessionStatus,
  persistentDisplaySettings,
  presentation = 'default',
  turnUsageMode = 'collapsed',
}: Args): {
  reversedItems: ChatRenderItem[];
  bottomFollowItemKey: string | null;
} {
  const snapshotStreams = streamingSlots?.assistantSnapshotStreams;
  const keepaliveProjection = useMemo(
    () => projectCacheKeepaliveTurns(events, pendingOptimistic),
    [events, pendingOptimistic],
  );
  const { displayEvents, suppressStreaming } = keepaliveProjection;
  const baseRenderItems = useMemo<ChatRenderItem[]>(
    () => {
      const grouped = groupChatEvents(displayEvents, snapshotStreams, persistentDisplaySettings);
      const presented = presentation === 'manuscript'
        ? projectPersistentTurnUsage(grouped, displayEvents, turnUsageMode)
        : grouped;
      const placed = placePendingOptimistic(presented, pendingOptimistic);
      return presentation === 'manuscript'
        ? groupAgentUserUtterances(placed)
        : placed;
    },
    [displayEvents, pendingOptimistic, persistentDisplaySettings, presentation, snapshotStreams, turnUsageMode],
  );
  const streamingRenderItems = useMemo(
    () => suppressStreaming ? [] : streamingSlotRenderItems(streamingSlots),
    [streamingSlots, suppressStreaming],
  );
  const hasStreamingAssistant = Boolean(
    !suppressStreaming && (
      streamingSlots?.assistant
      || Object.keys(streamingSlots?.assistantByStream ?? {}).length > 0
    ),
  );
  const hasHistoricalStreamingAssistantText = useMemo(
    () => hasActiveStreamingAssistantText(displayEvents, snapshotStreams),
    [displayEvents, snapshotStreams],
  );
  const bottomRenderItems = useMemo<ChatRenderItem[]>(() => {
    if (suppressStreaming) return [];
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
    suppressStreaming,
    streamingRenderItems,
  ]);
  const chronologicalItems = useMemo(
    () => [...baseRenderItems, ...bottomRenderItems],
    [baseRenderItems, bottomRenderItems],
  );
  const presentedItems = useMemo(
    () => projectManuscriptActivity(chronologicalItems, presentation === 'manuscript'),
    [chronologicalItems, presentation],
  );
  const incomingReversedItems = useMemo(
    () => [...presentedItems].reverse(),
    [presentedItems],
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
  const bottomTargetKey = bottomFollowTargetKey(presentedItems);
  const bottomTarget = presentedItems.find(item => item.key === bottomTargetKey);
  const streamingText = presentation === 'manuscript'
    && bottomTarget?.kind === 'event'
    && bottomTarget.key.startsWith('stream-assistant')
    ? (bottomTarget.event.data as Record<string, unknown> | undefined)?.text
    : undefined;
  const bottomFollowItemKey = typeof streamingText === 'string'
    ? `${bottomTargetKey}:${streamingText.length}`
    : bottomTargetKey;

  return { reversedItems, bottomFollowItemKey };
}
