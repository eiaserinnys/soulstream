import type { SessionEvent } from '../../api/types';
import type {
  ChatRenderItem,
  TurnSummaryRenderItem,
} from './groupChatEvents';

// Native uses its existing SessionEvent wire adapter: no external workspace package or EAS dependency.
function isJevCardObservation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const event=value as Record<string,unknown>;
  return event.type === 'debug' && event.kind === 'jev_card_observation'
    && positivePayloadEventId(event.complete_event_id) !== null
    && positivePayloadEventId(event.final_response_event_id) !== null
    && typeof event.content === 'string' && Array.isArray(event.details)
    && event.details.every(line=>typeof line === 'string');
}

function positiveEventId(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function positivePayloadEventId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function warnInvalidTurnSummary(event: SessionEvent, reason: string): void {
  if (__DEV__) {
    console.warn(
      `[groupChatEvents] turn_summary ${event.id} hidden: ${reason}`,
    );
  }
}

function renderItemEventIds(item: ChatRenderItem): number[] {
  if (item.kind === 'event') {
    const eventId = positiveEventId(item.event.id);
    return eventId === null ? [] : [eventId];
  }
  if (item.kind === 'tool') {
    return [item.start.id, item.result?.id]
      .map(positiveEventId)
      .filter((id): id is number => id !== null);
  }
  return [];
}

function renderItemSortKey(item: ChatRenderItem): number {
  const ids = renderItemEventIds(item);
  return ids.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...ids);
}

interface IndexedTurnSummary {
  event: SessionEvent;
  sourceIndex: number;
  eventId: number | null;
}

/**
 * 유효 event ID를 먼저 오름차순으로 두고 malformed ID는 원본 순서로 뒤에 둔다.
 * 유효/무효 비교에서 source 순서와 ID 순서를 섞으면 비교 관계가 순환할 수 있으므로,
 * 두 부류를 먼저 분리해 모든 입력에서 deterministic total order를 보장한다.
 */
function compareTurnSummaries(
  a: IndexedTurnSummary,
  b: IndexedTurnSummary,
): number {
  if (a.eventId === null && b.eventId === null) {
    return a.sourceIndex - b.sourceIndex;
  }
  if (a.eventId === null) return 1;
  if (b.eventId === null) return -1;
  return a.eventId - b.eventId || a.sourceIndex - b.sourceIndex;
}

export function placeTurnSummaries(
  baseItems: ChatRenderItem[],
  events: SessionEvent[],
): ChatRenderItem[] {
  const itemIndexByEventId = new Map<number, number>();
  baseItems.forEach((item, index) => {
    for (const eventId of renderItemEventIds(item)) {
      itemIndexByEventId.set(eventId, index);
    }
  });

  const afterItemIndex = new Map<number, TurnSummaryRenderItem[]>();
  const legacyBeforeItemIndex = new Map<number, ChatRenderItem[]>();
  const legacyAtEnd: ChatRenderItem[] = [];
  const seenSummaryIds = new Set<number>();
  const summaries = events
    .filter((event) => event.type === 'turn_summary' || isJevCardObservation({ ...event.data, type: event.type }))
    .map((event, sourceIndex) => ({
      event,
      sourceIndex,
      eventId: positiveEventId(event.id),
    }))
    .sort(compareTurnSummaries);

  for (const { event, eventId } of summaries) {
    if (eventId === null) {
      warnInvalidTurnSummary(event, 'event id is invalid');
      continue;
    }
    if (seenSummaryIds.has(eventId)) continue;
    seenSummaryIds.add(eventId);

    const observation = isJevCardObservation({ ...event.data, type: event.type });
    if (observation && summaries.some(item => item.eventId !== null && item.eventId > eventId
      && item.event.type === 'debug' && item.event.data?.kind === 'jev_card_observation'
      && item.event.data.complete_event_id === event.data?.complete_event_id)) continue;
    const content =
      typeof event.data?.content === 'string'
        ? event.data.content.trim()
        : '';
    if (!content) {
      warnInvalidTurnSummary(event, 'content is missing');
      continue;
    }

    const finalAnchor = positivePayloadEventId(
      event.data?.final_response_event_id,
    );
    const parentAnchor = observation ? null : positivePayloadEventId(event.data?.parent_event_id);
    const finalIndex =
      finalAnchor === null ? undefined : itemIndexByEventId.get(finalAnchor);
    const parentIndex =
      parentAnchor === null ? undefined : itemIndexByEventId.get(parentAnchor);
    const anchorEventId =
      finalIndex !== undefined
        ? finalAnchor
        : parentIndex !== undefined
          ? parentAnchor
          : null;
    const anchorIndex = finalIndex !== undefined ? finalIndex : parentIndex;

    if (anchorIndex !== undefined && anchorEventId !== null) {
      const item: TurnSummaryRenderItem = {
        kind: 'turn-summary',
        event,
        content,
        ...(observation ? { details: event.data?.details as string[] } : {}),
        anchorEventId,
        key: `turn-summary-${event.id}`,
      };
      const bucket = afterItemIndex.get(anchorIndex) ?? [];
      bucket.push(item);
      afterItemIndex.set(anchorIndex, bucket);
      continue;
    }
    if (finalAnchor !== null || parentAnchor !== null) continue;

    const legacyItem: ChatRenderItem = {
      kind: 'turn-summary',
      event,
      content,
      anchorEventId: eventId,
      key: `turn-summary-${event.id}`,
    };
    const insertionIndex = baseItems.findIndex(
      (item) => renderItemSortKey(item) > eventId,
    );
    if (insertionIndex === -1) {
      legacyAtEnd.push(legacyItem);
    } else {
      const bucket = legacyBeforeItemIndex.get(insertionIndex) ?? [];
      bucket.push(legacyItem);
      legacyBeforeItemIndex.set(insertionIndex, bucket);
    }
  }

  const out: ChatRenderItem[] = [];
  baseItems.forEach((item, index) => {
    out.push(...(legacyBeforeItemIndex.get(index) ?? []));
    const summaries = afterItemIndex.get(index);
    if (
      summaries !== undefined &&
      summaries.length > 0 &&
      (item.kind === 'event' || item.kind === 'tool')
    ) {
      out.push({ ...item, summaries });
    } else {
      out.push(item);
    }
  });
  out.push(...legacyAtEnd);
  return out;
}
