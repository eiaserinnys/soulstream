import type { SessionEvent } from '../../api/types';
import type {
  ChatRenderItem,
  TurnSummaryRenderItem,
} from './groupChatEvents';
import { formatRelativeTime } from '../../lib/relative-time';
import {
  isPersistentJevCandidatesDebugEvent,
} from '../../../../packages/wire-schema/src/persistent_jev_candidates';

function assignedCardPreparedInputId(event: SessionEvent): string | null {
  if (event.type !== 'debug' || event.data?.kind !== 'assigned_card_context_snapshot') return null;
  if (typeof event.data?.content !== 'string' || event.data.content.trim().length === 0) return null;
  const capture = event.data?.capture;
  if (!capture || typeof capture !== 'object') return null;
  const value = capture as Record<string, unknown>;
  return value.source === 'prepared_model_input'
    && value.identityMissing === false
    && typeof value.registrationId === 'string' && value.registrationId.length > 0
    && typeof value.executionCommandId === 'string' && value.executionCommandId.length > 0
    && typeof value.inputId === 'string' && value.inputId.length > 0
    ? value.inputId
    : null;
}

export function formatAssignedCardContextSnapshot(snapshot: Record<string,unknown>): string {
  const cards=Array.isArray(snapshot.cards) ? snapshot.cards.filter((card):card is Record<string,unknown>=>!!card&&typeof card==='object') : [];
  if (!cards.length) return '담당 카드 없음';
  const capturedAt=typeof snapshot.capturedAt==='string' ? Date.parse(snapshot.capturedAt) : Number.NaN;
  return cards.map(card=>[
    typeof card.title==='string'?card.title.replace(/\s+/g,' ').trim():'',
    statusLabel(typeof card.status==='string'?card.status:''),
    reportLabel(card,capturedAt),
    hasLaterComment(card)?'최근 커멘트 이후 보고 없음':null,
  ].filter(Boolean).join(' · ')).join('\n');
}

export function isEmptyAssignedCardContextSnapshot(
  item: TurnSummaryRenderItem,
): boolean {
  const event = item.event;
  if (event.type !== 'debug' || event.data?.kind !== 'assigned_card_context_snapshot') return false;
  const capture = event.data.capture;
  if (!capture || typeof capture !== 'object') return false;
  const snapshot = (capture as Record<string, unknown>).snapshot;
  if (!snapshot || typeof snapshot !== 'object') return false;
  const cards = (snapshot as Record<string, unknown>).cards;
  return Array.isArray(cards)
    && cards.filter((card) => !!card && typeof card === 'object').length === 0;
}

function reportLabel(card: Record<string,unknown>, capturedAt: number): string {
  if (!Object.prototype.hasOwnProperty.call(card,'latestReportAt')) return '마지막 보고 시각 확인 불가';
  if (card.latestReportAt===null) return '보고 없음';
  if (typeof card.latestReportAt!=='string' || !Number.isFinite(Date.parse(card.latestReportAt)) || !Number.isFinite(capturedAt)) return '마지막 보고 시각 확인 불가';
  return `마지막 보고 ${formatRelativeTime(card.latestReportAt,capturedAt)}`;
}

function hasLaterComment(card: Record<string,unknown>): boolean {
  return typeof card.latestCommentAt==='string' && typeof card.latestReportAt==='string'
    && Date.parse(card.latestCommentAt)>Date.parse(card.latestReportAt);
}

function statusLabel(status:string):string {
  return ({todo:'할 일',queued:'대기',blocked:'막힘',running:'실행 중',review:'검수 대기',done:'완료',cancelled:'취소'} as Record<string,string>)[status]??status;
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
  preparedInputId: string | null;
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
  const itemIndexByInputId = new Map<string, number>();
  baseItems.forEach((item, index) => {
    for (const eventId of renderItemEventIds(item)) {
      itemIndexByEventId.set(eventId, index);
    }
    if (
      item.kind === 'event'
      && (item.event.type === 'user_message' || item.event.type === 'intervention_sent')
      && typeof item.event.data?.input_id === 'string'
      && item.event.data.input_id.length > 0
    ) itemIndexByInputId.set(item.event.data.input_id, index);
  });

  const afterItemIndex = new Map<number, TurnSummaryRenderItem[]>();
  const assignedContextAfterItemIndex = new Map<number, TurnSummaryRenderItem[]>();
  const legacyBeforeItemIndex = new Map<number, ChatRenderItem[]>();
  const legacyAtEnd: ChatRenderItem[] = [];
  const seenSummaryIds = new Set<number>();
  const summaries = events
    .filter((event) => event.type === 'turn_summary'
      || assignedCardPreparedInputId(event) !== null)
    .map((event, sourceIndex) => ({
      event,
      sourceIndex,
      eventId: positiveEventId(event.id),
      preparedInputId: assignedCardPreparedInputId(event),
    }))
    .sort(compareTurnSummaries);

  const latestAssignedByInputId = new Map<string, number>();
  for (const summary of summaries) {
    if (summary.preparedInputId === null || summary.eventId === null) continue;
    latestAssignedByInputId.set(
      summary.preparedInputId,
      Math.max(latestAssignedByInputId.get(summary.preparedInputId) ?? 0, summary.eventId),
    );
  }

  for (const { event, eventId, preparedInputId } of summaries) {
    if (eventId === null) {
      warnInvalidTurnSummary(event, 'event id is invalid');
      continue;
    }
    if (seenSummaryIds.has(eventId)) continue;
    seenSummaryIds.add(eventId);
    if (
      preparedInputId !== null
      && latestAssignedByInputId.get(preparedInputId) !== eventId
    ) continue;

    const rawContent =
      typeof event.data?.content === 'string'
        ? event.data.content
        : '';
    if (!rawContent.trim()) {
      warnInvalidTurnSummary(event, 'content is missing');
      continue;
    }
    const snapshot = event.data?.capture && typeof event.data.capture==='object'
      ? (event.data.capture as Record<string,unknown>).snapshot : null;
    const content = preparedInputId === null ? rawContent.trim()
      : snapshot && typeof snapshot==='object'
        ? formatAssignedCardContextSnapshot(snapshot as Record<string,unknown>)
        : rawContent;

    if (preparedInputId !== null) {
      const anchorIndex = itemIndexByInputId.get(preparedInputId);
      if (anchorIndex === undefined) continue;
      const anchor = baseItems[anchorIndex];
      if (!anchor || anchor.kind !== 'event') continue;
      const anchorEventId = positiveEventId(anchor.event.id);
      if (anchorEventId === null) continue;
      const item: TurnSummaryRenderItem = {
        kind: 'turn-summary', event, content, anchorEventId,
        key: `turn-summary-${event.id}`,
      };
      let jevIndex = -1;
      for (let index = anchorIndex + 1; index < baseItems.length; index += 1) {
        const candidate = baseItems[index];
        if (candidate.kind === 'jev-candidates' && candidate.anchorEventId === anchorEventId) {
          jevIndex = index;
        }
      }
      const placementIndex = jevIndex === -1 ? anchorIndex : jevIndex;
      const bucket = assignedContextAfterItemIndex.get(placementIndex) ?? [];
      bucket.push(item);
      assignedContextAfterItemIndex.set(placementIndex, bucket);
      continue;
    }

    const finalAnchor = positivePayloadEventId(
      event.data?.final_response_event_id,
    );
    const parentAnchor = positivePayloadEventId(event.data?.parent_event_id);
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
    out.push(...(assignedContextAfterItemIndex.get(index) ?? []));
  });
  out.push(...legacyAtEnd);
  return out;
}

export function placeJevCandidateCaptions(
  baseItems: ChatRenderItem[],
  events: SessionEvent[],
): ChatRenderItem[] {
  const itemIndexByInputId = new Map<string, number>();
  baseItems.forEach((item, index) => {
    if (
      item.kind === 'event'
      && (item.event.type === 'user_message' || item.event.type === 'intervention_sent')
      && typeof item.event.data?.input_id === 'string'
      && item.event.data.input_id.length > 0
    ) itemIndexByInputId.set(item.event.data.input_id, index);
  });

  const afterItemIndex = new Map<number, ChatRenderItem[]>();
  for (const event of events) {
    const debugEvent = { ...event.data, type: event.type };
    if (!isPersistentJevCandidatesDebugEvent(debugEvent)) continue;
    const anchorIndex = itemIndexByInputId.get(debugEvent.observation.input_id);
    if (anchorIndex === undefined) continue;
    const anchor = baseItems[anchorIndex];
    if (!anchor || anchor.kind !== 'event') continue;
    const anchorEventId = positiveEventId(anchor.event.id);
    if (anchorEventId === null) continue;

    const observation = debugEvent.observation;
    const lines = observation.selected.length === 0
      ? ['2점 이상인 후보가 없습니다.']
      : observation.selected.slice(0, 5).map((candidate) =>
        `${candidate.label} · ${candidate.line} · ${candidate.score}/3`,
      );
    const item: ChatRenderItem = {
      kind: 'jev-candidates',
      title: `Jev 후보 ${observation.selected.length}`,
      lines,
      anchorEventId,
      key: `jev-candidates-${event.id}`,
    };
    const bucket = afterItemIndex.get(anchorIndex) ?? [];
    bucket.push(item);
    afterItemIndex.set(anchorIndex, bucket);
  }

  if (afterItemIndex.size === 0) return baseItems;
  const out: ChatRenderItem[] = [];
  baseItems.forEach((item, index) => {
    out.push(item, ...(afterItemIndex.get(index) ?? []));
  });
  return out;
}
