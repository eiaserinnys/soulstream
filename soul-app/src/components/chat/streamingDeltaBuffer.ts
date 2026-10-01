import type { SessionEvent } from '../../api/types';
import { mergeAppendOnlyStreamingDelta } from '../../lib/streamingDeltaEvent';
import type { StreamingSlotKind } from '../../store/chatStore';

export const STREAMING_DELTA_FLUSH_MS = 50;

export interface PendingStreamingDelta {
  kind: StreamingSlotKind;
  event: SessionEvent;
  eid: string;
}

interface BufferedStreamingDelta extends PendingStreamingDelta {
  sequence: number;
}

export interface StreamingDeltaBuffer {
  pendingByKind: Partial<Record<StreamingSlotKind, BufferedStreamingDelta>>;
  order: StreamingSlotKind[];
  sequence: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface StreamingDeltaActions {
  commitStreamingEvent: (
    kind: StreamingSlotKind,
    event: SessionEvent,
  ) => void;
  setLastEventId: (eid: string) => void;
  /** timer-driven flush 실패 시 마지막 committed cursor에서 transport를 재시작한다. */
  onAsyncCommitError?: (error: unknown) => void;
}

export function createStreamingDeltaBuffer(): StreamingDeltaBuffer {
  return {
    pendingByKind: {},
    order: [],
    sequence: 0,
    timer: null,
  };
}

export function streamingDeltaKind(type: string): StreamingSlotKind | null {
  if (type === 'text_delta') return 'assistant';
  if (type === 'thinking_delta') return 'thinking';
  return null;
}

export function enqueueStreamingDelta(
  buffer: StreamingDeltaBuffer,
  pending: PendingStreamingDelta,
  actions: StreamingDeltaActions,
  delayMs = STREAMING_DELTA_FLUSH_MS,
): void {
  if (!buffer.pendingByKind[pending.kind]) {
    buffer.order.push(pending.kind);
  }
  buffer.sequence += 1;
  const previous = buffer.pendingByKind[pending.kind];
  buffer.pendingByKind[pending.kind] = {
    ...pending,
    event: mergeAppendOnlyStreamingDelta(previous?.event, pending.event),
    sequence: buffer.sequence,
  };

  if (buffer.timer !== null) return;
  buffer.timer = setTimeout(() => {
    try {
      flushStreamingDeltaBuffer(buffer, actions);
    } catch (error) {
      actions.onAsyncCommitError?.(error);
    }
  }, delayMs);
}

export function dispatchStreamingDelta(
  buffer: StreamingDeltaBuffer,
  pending: PendingStreamingDelta,
  actions: StreamingDeltaActions,
  delayMs = STREAMING_DELTA_FLUSH_MS,
): void {
  if (pending.kind !== 'assistant') {
    enqueueStreamingDelta(buffer, pending, actions, delayMs);
    return;
  }

  if (buffer.order.length > 0) {
    flushStreamingDeltaBuffer(buffer, actions);
  }

  actions.commitStreamingEvent(pending.kind, pending.event);
  if (pending.eid) actions.setLastEventId(pending.eid);
}

export function flushStreamingDeltaBuffer(
  buffer: StreamingDeltaBuffer,
  actions: StreamingDeltaActions,
): void {
  if (buffer.timer !== null) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }

  const pending = buffer.order
    .map((kind) => buffer.pendingByKind[kind])
    .filter((item): item is BufferedStreamingDelta => item !== undefined);
  for (const item of pending) {
    actions.commitStreamingEvent(item.kind, item.event);
  }

  const latestEid = pending.reduce<BufferedStreamingDelta | null>(
    (latest, item) => {
      if (!item.eid) return latest;
      if (!latest || item.sequence > latest.sequence) return item;
      return latest;
    },
    null,
  )?.eid;
  if (latestEid) actions.setLastEventId(latestEid);

  for (const item of pending) {
    if (buffer.pendingByKind[item.kind]?.sequence === item.sequence) {
      delete buffer.pendingByKind[item.kind];
    }
  }
  buffer.order = buffer.order.filter(
    (kind) => buffer.pendingByKind[kind] !== undefined,
  );
}

export function cancelStreamingDeltaBuffer(
  buffer: StreamingDeltaBuffer,
): void {
  if (buffer.timer !== null) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }
  buffer.pendingByKind = {};
  buffer.order = [];
}

export function streamingSlotTransitionForEvent(
  type: string,
  _data: unknown,
): { finalize: StreamingSlotKind[]; clear: StreamingSlotKind[] } {
  if (streamingDeltaKind(type)) {
    return { finalize: [], clear: [] };
  }
  if (type === 'history_sync') {
    return { finalize: [], clear: [] };
  }
  if (type === 'assistant_message') {
    return { finalize: ['thinking'], clear: [] };
  }
  return { finalize: ['assistant', 'thinking'], clear: [] };
}
