import type { SessionEvent } from '../api/types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textPayload(event: SessionEvent): string {
  const data = asRecord(event.data);
  if (!data) return '';
  if (typeof data.text === 'string') return data.text;
  if (typeof data.delta === 'string') return data.delta;
  if (typeof data.content === 'string') return data.content;
  return '';
}

function withTextPayload(event: SessionEvent, text: string): SessionEvent {
  const data = asRecord(event.data) ?? {};
  const key = typeof data.delta === 'string' && typeof data.text !== 'string'
    ? 'delta'
    : 'text';
  return {
    ...event,
    data: {
      ...data,
      [key]: text,
    },
  };
}

export function appendOnlyStreamingKey(event: SessionEvent): string | null {
  const data = asRecord(event.data);
  if (!data) return null;
  if (event.type !== 'text_delta') return null;
  if (
    typeof data.streamIdentity === 'string'
    && data.streamIdentity.length > 0
    && (data.liveTextMode === 'append' || data.liveTextMode === 'replace')
  ) {
    return data.streamIdentity;
  }
  if (data._live_only !== true) return null;
  if (data.raw_event_type !== 'item/agentMessage/delta') return null;
  const key = data.tool_use_id ?? data.item_id;
  return typeof key === 'string' && key ? key : null;
}

export function mergeAppendOnlyStreamingDelta(
  previous: SessionEvent | undefined,
  next: SessionEvent,
): SessionEvent {
  if (!previous) return next;
  const previousKey = appendOnlyStreamingKey(previous);
  const nextKey = appendOnlyStreamingKey(next);
  if (!previousKey || previousKey !== nextKey) return next;

  // The SSE gate derives the same id for an exact server-frame retransmit.
  // `previous` may already contain earlier appended chunks, so retain it rather
  // than replacing it with the retransmitted raw chunk.
  if (previous.id === next.id) return previous;

  const liveTextMode = asRecord(next.data)?.liveTextMode;
  if (liveTextMode === 'replace') return next;

  const previousText = textPayload(previous);
  const nextText = textPayload(next);
  if (!nextText) return next;
  if (!previousText) return next;

  // appendOnlyStreamingKey accepts either an explicit v2 append stream or the
  // legacy item/agentMessage/delta wire event; both carry chunk deltas.
  return withTextPayload(next, `${previousText}${nextText}`);
}
