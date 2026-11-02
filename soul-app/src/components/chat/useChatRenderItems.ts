import { useMemo, useRef } from 'react';
import type { SessionEvent } from '../../api/types';
import type { PersistentTurnUsageMode } from '../../api/persistentSessionEndpoints';
import type { StreamingSlots } from '../../store/chatStore';
import type { PersistentDisplayProjectionSettings } from './groupChatEvents';
import {
  groupChatEvents,
  projectManuscriptMessages,
  hasActiveStreamingAssistantText,
  placePendingOptimistic,
  streamingSlotRenderItems,
  type ChatRenderItem,
} from './groupChatEvents';
import { projectManuscriptActivity } from './manuscriptActivityProjection';
import { projectPersistentWorkDetails } from './persistentWorkDetailsProjection';
import { replaceEqualDeep } from '../../lib/structural-sharing';
import { bottomFollowTargetKey } from './bottomFollow';
import { projectPersistentTurnUsage } from './persistentTurnUsageProjection';
import { projectCacheKeepaliveTurns } from './cacheKeepaliveProjection';
import { projectOutputAttachments } from '../../lib/output-attachment-projection';
import { collapseReportTimeline } from '../../../../packages/wire-schema/src/persistent_report';

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
  const placedRenderItems = useMemo<ChatRenderItem[]>(
    () => {
      const grouped = groupChatEvents(displayEvents, snapshotStreams, persistentDisplaySettings);
      const withOutputAttachments = projectOutputAttachments(grouped, displayEvents);
      const presented = presentation === 'manuscript'
        ? projectPersistentTurnUsage(withOutputAttachments, displayEvents, turnUsageMode)
        : withOutputAttachments;
      return placePendingOptimistic(presented, pendingOptimistic);
    },
    [displayEvents, pendingOptimistic, persistentDisplaySettings, presentation, snapshotStreams, turnUsageMode],
  );
  const baseRenderItems = useMemo<ChatRenderItem[]>(
    () => presentation === 'manuscript'
      ? projectManuscriptMessages(placedRenderItems)
      : placedRenderItems,
    [placedRenderItems, presentation],
  );
  const collapsedBaseRenderItems = useMemo(
    () => collapseReportTimeline(baseRenderItems, (item) => {
      if (item.kind !== 'event' || item.event.type !== 'report_timeline') return null;
      const key = item.event.data.line_key;
      return typeof key === 'string' ? key : null;
    }, (item) => item.kind === 'event' && (
      item.event.type === 'user_message'
      || item.event.type === 'intervention_sent'
      || item.event.type === 'assistant_message'
      || item.event.type === 'text_delta'
      || item.event.type === 'realtime_transcript'
    )),
    [baseRenderItems],
  );
  const streamingRenderItems = useMemo(
    () => {
      if (suppressStreaming) return [];
      const rawStreamingItems = streamingSlotRenderItems(streamingSlots);
      if (presentation !== 'manuscript' || rawStreamingItems.length === 0) return rawStreamingItems;

      const streamingKeys = new Set(rawStreamingItems.map((item) => item.key));
      return projectManuscriptMessages([...placedRenderItems, ...rawStreamingItems])
        .filter((item) => streamingKeys.has(item.key));
    },
    [placedRenderItems, presentation, streamingSlots, suppressStreaming],
  );
  // Keep raw assistant liveness even when manuscript projection intentionally hides its row.
  // This avoids replacing a deliberate silent response with a typing row.
  const hasStreamingAssistant = Boolean(
    !suppressStreaming && (
      streamingSlots?.assistant
      || Object.keys(streamingSlots?.assistantByStream ?? {}).length > 0
    ),
  );
  const hasHistoricalStreamingAssistantText = useMemo(
    // Keep active raw delta state even if manuscript projection filters its row.
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
    () => [...collapsedBaseRenderItems, ...bottomRenderItems],
    [collapsedBaseRenderItems, bottomRenderItems],
  );
  const hideWorkDetails = presentation === 'manuscript'
    && persistentDisplaySettings !== undefined
    && persistentDisplaySettings.showWorkDetails !== true;
  const presentedItems = useMemo(
    () => {
      const presented = projectManuscriptActivity(chronologicalItems, presentation === 'manuscript');
      return hideWorkDetails ? projectPersistentWorkDetails(presented) : presented;
    },
    [chronologicalItems, hideWorkDetails, presentation],
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
