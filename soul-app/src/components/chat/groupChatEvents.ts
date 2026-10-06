import type { SessionEvent, SessionEventType } from '../../api/types';
import type { HistoricalMessage } from '../../api/client';
import {
  getOptimisticAfterEventId,
  type StreamingSlotKind,
  type StreamingSlots,
} from '../../store/chatStore';
import { placeJevCandidateCaptions, placeTurnSummaries } from './turnSummaryProjection';

/**
 * 채팅 본문 FlatList의 RenderItem 타입.
 *
 * - `event`: 일반 이벤트(user_message, assistant_message, thinking, system 등).
 *   orphan tool_result는 출력에서 제외 (F-F 가드 — invisible phantom cell 차단).
 * - `tool`: tool_start와 같은 tool_use_id의 tool_result를 한 그룹으로 묶은 항목.
 *   매칭 result가 없으면 `result`는 undefined.
 * - anchored `turn-summary`: 응답 행의 `summaries`에 결합되어 행 key와 수를 유지.
 * - standalone `turn-summary`: 유효 anchor 후보가 전혀 없는 legacy fail-open 캡션.
 * - `typing`: 세션 status='running'일 때 화면 최하단에 추가되는 타이핑 인디케이터.
 */
export type TurnSummaryRenderItem = {
  kind: 'turn-summary';
  event: SessionEvent;
  content: string;
  anchorEventId: number;
  key: string;
};

export type JevCandidatesRenderItem = {
  kind: 'jev-candidates';
  title: string;
  lines: string[];
  anchorEventId: number;
  key: string;
};

export type TurnUsageCaption = {
  title: string;
  expandedTitle?: string;
  lines: string[];
};

export type TurnUsageRenderItem = TurnUsageCaption & {
  kind: 'turn-usage';
  event: SessionEvent;
  key: string;
  summaries?: TurnSummaryRenderItem[];
};

export type ChatRenderItem =
  | {
      kind: 'event';
      event: SessionEvent;
      key: string;
      summaries?: TurnSummaryRenderItem[];
      turnUsageCaption?: TurnUsageCaption;
    }
  | {
      kind: 'tool';
      start: SessionEvent;
      result?: SessionEvent;
      key: string;
      summaries?: TurnSummaryRenderItem[];
    }
  | TurnSummaryRenderItem
  | JevCandidatesRenderItem
  | TurnUsageRenderItem
  | { kind: 'typing'; key: string };

export interface PersistentDisplayProjectionSettings {
  showGenerationSeparator: boolean;
  showJevCandidates: boolean;
}

function streamingIdentity(event: SessionEvent): string | null {
  const data = event.data as Record<string, unknown> | undefined;
  const identity =
    data?.streamIdentity ??
    data?.tool_use_id ??
    data?.item_id ??
    data?.parent_event_id;
  return identity === undefined || identity === null ? null : String(identity);
}

function streamingSlotRenderKey(
  kind: StreamingSlotKind,
  event: SessionEvent,
): string {
  const identity = streamingIdentity(event);
  return identity ? `stream-${kind}-${identity}` : `stream-${kind}`;
}

export function streamingSlotRenderItems(
  streamingSlots: StreamingSlots | undefined,
): ChatRenderItem[] {
  const out: ChatRenderItem[] = [];
  if (streamingSlots?.thinking) {
    out.push({
      kind: 'event',
      event: streamingSlots.thinking,
      key: streamingSlotRenderKey('thinking', streamingSlots.thinking),
    });
  }
  if (streamingSlots?.assistant) {
    out.push({
      kind: 'event',
      event: streamingSlots.assistant,
      key: streamingSlotRenderKey('assistant', streamingSlots.assistant),
    });
  }
  for (const event of Object.values(streamingSlots?.assistantByStream ?? {})) {
    out.push({
      kind: 'event',
      event,
      key: streamingSlotRenderKey('assistant', event),
    });
  }
  return out;
}

function textPayload(e: SessionEvent): string {
  const d = e.data as any;
  if (typeof d?.content === 'string') return d.content;
  if (typeof d?.text === 'string') return d.text;
  if (typeof d?.delta === 'string') return d.delta;
  return '';
}

function mergeLiveText(current: string, event: SessionEvent): string {
  const next = textPayload(event);
  return (event.data as any)?.liveTextMode === 'replace'
    ? next
    : current + next;
}

function makeTextEvent(base: SessionEvent, text: string): SessionEvent {
  return {
    ...base,
    data: {
      ...base.data,
      text,
    },
  };
}

function makeFinalAssistantEvent(base: SessionEvent, text: string): SessionEvent {
  const data = { ...base.data };
  delete data._live_only;
  return {
    ...base,
    type: 'assistant_message',
    data: {
      ...data,
      type: 'assistant_message',
      text,
    },
  };
}

function isAppServerTextDelta(e: SessionEvent): boolean {
  return (
    (e.data as any)?.raw_event_type === 'item/agentMessage/delta'
    || typeof (e.data as any)?.streamIdentity === 'string'
  );
}

function appServerStreamKey(e: SessionEvent): string | null {
  // Durable replay predates hub decoration, so raw item identity must win when
  // comparing it with a later decorated final carrying both forms.
  const key = (e.data as any)?.tool_use_id
    ?? (e.data as any)?.item_id
    ?? (e.data as any)?.streamIdentity;
  return typeof key === 'string' && key ? key : null;
}

function isAppServerFinalAssistant(e: SessionEvent): boolean {
  return e.type === 'assistant_message' && (e.data as any)?._final_for_live_stream === true;
}

function isLiveOnlyTextLifecycle(e: SessionEvent): boolean {
  return (
    (
      (e.data as any)?._live_only === true
      || typeof (e.data as any)?.streamIdentity === 'string'
    ) &&
    (e.type === 'text_start' || e.type === 'text_delta' || e.type === 'text_end')
  );
}

function isCoveredBySnapshot(
  event: SessionEvent,
  snapshotStreams: Readonly<Record<string, true>> | undefined,
): boolean {
  if (!snapshotStreams || !isLiveOnlyTextLifecycle(event)) return false;
  const identity = (event.data as any)?.streamIdentity;
  if (typeof identity === 'string' && identity.length > 0) {
    return snapshotStreams[identity] === true;
  }
  // Production durable replay is persisted before hub decoration, so its raw
  // lifecycle has no opaque identity to compare. An active snapshot owns it.
  return Object.keys(snapshotStreams).length > 0;
}

function collectFinalizedStreamKeys(events: SessionEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (!isAppServerFinalAssistant(event)) continue;
    const key = appServerStreamKey(event);
    if (key) keys.add(key);
  }
  return keys;
}

function shouldSkipFinalizedLiveText(
  e: SessionEvent,
  finalizedStreamKeys: Set<string>,
): boolean {
  if (!isLiveOnlyTextLifecycle(e)) return false;
  const key = appServerStreamKey(e);
  return !!key && finalizedStreamKeys.has(key);
}

function collectFinalizedLiveText(
  events: SessionEvent[],
  finalizedStreamKeys: Set<string>,
): Map<string, { base: SessionEvent; text: string }> {
  const buffers = new Map<string, { base: SessionEvent | null; text: string }>();
  for (const event of events) {
    if (!shouldSkipFinalizedLiveText(event, finalizedStreamKeys)) continue;
    if (event.type !== 'text_delta') continue;
    const key = appServerStreamKey(event);
    if (!key) continue;
    const current = buffers.get(key) ?? { base: null, text: '' };
    buffers.set(key, {
      base: current.base ?? event,
      text: mergeLiveText(current.text, event),
    });
  }

  const out = new Map<string, { base: SessionEvent; text: string }>();
  for (const [key, value] of buffers) {
    if (value.base && value.text.trim().length > 0) {
      out.set(key, { base: value.base, text: value.text });
    }
  }
  return out;
}

export function hasActiveStreamingAssistantText(
  events: SessionEvent[],
  snapshotStreams?: Readonly<Record<string, true>>,
): boolean {
  const finalizedStreamKeys = collectFinalizedStreamKeys(events);
  let active = false;
  let text = '';
  let streamKey: string | null = null;
  for (const e of events) {
    if (isCoveredBySnapshot(e, snapshotStreams)) continue;
    if (shouldSkipFinalizedLiveText(e, finalizedStreamKeys)) continue;
    if (e.type === 'text_start') {
      active = true;
      text = '';
      streamKey = appServerStreamKey(e);
      continue;
    }
    if (e.type === 'text_delta') {
      if (active || isAppServerTextDelta(e)) {
        active = true;
        text = mergeLiveText(text, e);
        streamKey = streamKey ?? appServerStreamKey(e);
      }
      continue;
    }
    if (isAppServerFinalAssistant(e)) {
      const finalKey = appServerStreamKey(e);
      if (!streamKey || !finalKey || streamKey === finalKey) {
        active = false;
        text = '';
        streamKey = null;
      }
      continue;
    }
    if (e.type === 'text_end') {
      active = false;
      text = '';
      streamKey = null;
    }
  }
  return active && text.trim().length > 0;
}

/**
 * 이벤트 평면 배열을 RenderItem 배열로 변환한다.
 *
 * tool_start 발견 시, 같은 tool_use_id를 가진 다음 tool_result를 같은 그룹으로 묶는다.
 * 매칭되지 않은 tool_result(orphan)는 EventRenderer.tsx의 case 'tool_result' → null 분기로
 * 인해 zero-height invisible phantom cell이 되므로 (F-F), 출력에서 제외한다.
 * prepend로 매칭 tool_start가 도착하면 forward iterate가 매칭하여 자가 회복.
 */
export function groupChatEvents(
  events: SessionEvent[],
  snapshotStreams?: Readonly<Record<string, true>>,
  displaySettings?: PersistentDisplayProjectionSettings,
): ChatRenderItem[] {
  const out: ChatRenderItem[] = [];
  const consumed = new Set<number>();
  const finalizedStreamKeys = collectFinalizedStreamKeys(events);
  const finalizedLiveText = collectFinalizedLiveText(events, finalizedStreamKeys);
  let textBase: SessionEvent | null = null;
  let textBuffer = '';
  let textStreamActive = false;
  let textStreamKey: string | null = null;
  let textStreamLiveOnly = false;

  const flushText = ({ final = false }: { final?: boolean } = {}) => {
    if (textBase && textBuffer.trim().length > 0) {
      out.push({
        kind: 'event',
        event: final
          ? makeFinalAssistantEvent(textBase, textBuffer)
          : makeTextEvent(textBase, textBuffer),
        key: `evt-${textBase.id}`,
      });
    }
    textBase = null;
    textBuffer = '';
    textStreamActive = false;
    textStreamKey = null;
    textStreamLiveOnly = false;
  };

  events.forEach((e, i) => {
    if (consumed.has(i)) return;
    if (e.type === 'turn_summary' || e.type === 'debug' || e.type === 'result') return;
    if (e.type === 'generation_started' && displaySettings?.showGenerationSeparator !== true) return;
    // Durable replay is stored before the hub decorates liveSeq/streamIdentity.
    // While a snapshot owns an active stream, its raw text lifecycle is already
    // represented by the recovered slot and must not become a second row.
    if (isCoveredBySnapshot(e, snapshotStreams)) return;
    if (shouldSkipFinalizedLiveText(e, finalizedStreamKeys)) return;

    // F-F: orphan tool_result 출력 제외. 정상 매칭된 tool_result는 위의 consumed.has(i)
    // 가드로 이미 skip되므로(아래 tool_start 분기에서 consumed.add(j) 처리), 본 가드는
    // *consumed에 들어가지 않은 orphan tool_result*에만 도달한다.
    if (e.type === 'tool_result') {
      return;
    }

    if (e.type === 'text_start') {
      flushText();
      textStreamActive = true;
      textStreamKey = appServerStreamKey(e);
      textStreamLiveOnly = isLiveOnlyTextLifecycle(e);
      return;
    }

    if (e.type === 'text_delta') {
      if (textStreamActive || isAppServerTextDelta(e)) {
        if (!textBase) textBase = e;
        textBuffer = mergeLiveText(textBuffer, e);
        textStreamActive = true;
        textStreamKey = textStreamKey ?? appServerStreamKey(e);
        textStreamLiveOnly ||= isLiveOnlyTextLifecycle(e);
      } else {
        out.push({ kind: 'event', event: e, key: `evt-${e.id}` });
      }
      return;
    }

    if (isAppServerFinalAssistant(e)) {
      const finalKey = appServerStreamKey(e);
      const live = finalKey ? finalizedLiveText.get(finalKey) : undefined;
      if (live) {
        flushText();
        out.push({
          kind: 'event',
          event: makeFinalAssistantEvent(e, textPayload(e) || live.text),
          key: `evt-${live.base.id}`,
        });
        return;
      }
    }

    if (isAppServerFinalAssistant(e) && textBase) {
      const finalKey = appServerStreamKey(e);
      if (!textStreamKey || !finalKey || textStreamKey === finalKey) {
        textBuffer = textPayload(e) || textBuffer;
        const key = `evt-${textBase.id}`;
        const text = textBuffer;
        textBase = null;
        textBuffer = '';
        textStreamActive = false;
        textStreamKey = null;
        textStreamLiveOnly = false;
        out.push({
          kind: 'event',
          event: makeFinalAssistantEvent(e, text),
          key,
        });
        return;
      }
    }

    if (e.type === 'text_end') {
      flushText({ final: !textStreamLiveOnly });
      return;
    }

    flushText();

    if (e.type === 'tool_start') {
      const startId =
        ((e.data as any)?.tool_use_id as string | undefined) ??
        ((e.data as any)?.id as string | undefined);
      let matched: SessionEvent | undefined;
      if (startId) {
        for (let j = i + 1; j < events.length; j++) {
          const r = events[j];
          if (
            r.type === 'tool_result' &&
            ((r.data as any)?.tool_use_id as string | undefined) === startId
          ) {
            matched = r;
            consumed.add(j);
            break;
          }
        }
      }
      out.push({ kind: 'tool', start: e, result: matched, key: `tool-${e.id}` });
      return;
    }

    out.push({ kind: 'event', event: e, key: `evt-${e.id}` });
  });

  flushText();
  const withJevCandidateCaptions = displaySettings?.showJevCandidates === true
    ? placeJevCandidateCaptions(out, events)
    : out;
  return placeTurnSummaries(withJevCandidateCaptions, events);
}

export function placePendingOptimistic(
  items: ChatRenderItem[],
  pendingOptimistic: SessionEvent | undefined,
): ChatRenderItem[] {
  if (!pendingOptimistic) return items;
  const optimisticItem: ChatRenderItem = {
    kind: 'event',
    event: pendingOptimistic,
    key: `evt-${pendingOptimistic.id}`,
  };
  const afterEventId = getOptimisticAfterEventId(pendingOptimistic);
  if (afterEventId === null) {
    return [optimisticItem, ...items];
  }
  const anchor = Number(afterEventId);
  if (!Number.isFinite(anchor)) return [...items, optimisticItem];

  const insertionIndex = items.findIndex((item) => {
    const itemId = renderItemSortKey(item);
    return Number.isFinite(itemId) && itemId > anchor;
  });
  if (insertionIndex === -1) return [...items, optimisticItem];
  return [
    ...items.slice(0, insertionIndex),
    optimisticItem,
    ...items.slice(insertionIndex),
  ];
}

function renderItemSortKey(item: ChatRenderItem): number {
  if (item.kind === 'typing') return Number.MAX_SAFE_INTEGER;
  if (item.kind === 'turn-summary') return item.anchorEventId;
  if (item.kind === 'jev-candidates') return item.anchorEventId;
  if (item.kind === 'tool') {
    return Math.max(Number(item.start.id), Number(item.result?.id ?? item.start.id));
  }
  return Number(item.event.id);
}

/**
 * DB 메시지 한 건을 SessionEvent로 정규화한다.
 *
 * payload.type은 SDK 형식('tool_use'/'tool_result')이라 EventRenderer의
 * 서버 카테고리('tool_start'/'tool_result')와 정합이 어긋나므로 event_type 컬럼만 사용.
 */
export function toSessionEvent(m: HistoricalMessage): SessionEvent {
  return {
    id: String(m.id),
    type: m.event_type as SessionEventType,
    data: m.payload,
  };
}
