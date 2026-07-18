import { randomUUID } from "node:crypto";

export type SnapshotRefetchReason = "ring_gap" | "instance_mismatch";

export const SNAPSHOT_REFETCH_REASONS = [
  "ring_gap",
  "instance_mismatch",
] as const satisfies readonly SnapshotRefetchReason[];

export type SseStreamMeta = {
  type: "stream_meta";
  instance_id: string;
  latest_id: number;
};

export type SseResumeCursor = {
  lastEventId: number | null;
  instanceId: string | null;
};

export type SseResumeInput = {
  lastEventIdHeader?: string | number | null;
  lastEventIdQuery?: string | number | null;
  instanceIdQuery?: string | null;
};

export type SseReplayEvent<TPayload extends object = Record<string, unknown>> = {
  id: number;
  payload: TPayload;
};

export type SseReplayResult<TPayload extends object = Record<string, unknown>> = {
  events: Array<SseReplayEvent<TPayload>>;
  gap: boolean;
  gapReason: SnapshotRefetchReason | null;
  snapshotRefetch: boolean;
  latestId: number;
  instanceId: string;
  streamMeta: SseStreamMeta;
};

export type SseReplayBroadcasterOptions = {
  instanceId?: string;
  ringMaxlen?: number;
};

export type SessionStreamEvent = {
  type: "session_created" | "session_updated" | "session_deleted" | string;
  agent_session_id?: string;
  [key: string]: unknown;
};

type SseEventListener<TPayload extends object> = (event: SseReplayEvent<TPayload>) => void;

const DEFAULT_RING_MAXLEN = 1000;

export function parseLastEventId(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid Last-Event-ID: ${String(value)}`);
  }
  return parsed;
}

export function resolveSseResumeCursor(input: SseResumeInput): SseResumeCursor {
  return {
    lastEventId: parseLastEventId(input.lastEventIdHeader ?? input.lastEventIdQuery),
    instanceId: input.instanceIdQuery ?? null,
  };
}

export class InMemorySseReplayBroadcaster<
  TPayload extends object = Record<string, unknown>,
> {
  readonly instanceId: string;
  readonly ringMaxlen: number;

  private latestId = 0;
  private readonly ring: Array<SseReplayEvent<TPayload>> = [];
  private readonly listeners = new Set<SseEventListener<TPayload>>();

  constructor(options: SseReplayBroadcasterOptions = {}) {
    const ringMaxlen = options.ringMaxlen ?? DEFAULT_RING_MAXLEN;
    if (!Number.isInteger(ringMaxlen) || ringMaxlen <= 0) {
      throw new Error(`ringMaxlen must be a positive integer: ${ringMaxlen}`);
    }

    this.instanceId = options.instanceId ?? randomUUID().replaceAll("-", "");
    this.ringMaxlen = ringMaxlen;
  }

  get latestEventId(): number {
    return this.latestId;
  }

  get oldestBufferedEventId(): number | null {
    return this.ring[0]?.id ?? null;
  }

  get streamMeta(): SseStreamMeta {
    return {
      type: "stream_meta",
      instance_id: this.instanceId,
      latest_id: this.latestId,
    };
  }

  get bufferedEvents(): Array<SseReplayEvent<TPayload>> {
    return [...this.ring];
  }

  subscribe(listener: SseEventListener<TPayload>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  append(payload: TPayload): SseReplayEvent<TPayload> {
    this.latestId += 1;
    const event: SseReplayEvent<TPayload> = {
      id: this.latestId,
      payload,
    };

    this.ring.push(event);
    this.trimRing();

    for (const listener of this.listeners) {
      listener(event);
    }

    return event;
  }

  replaySince(
    lastEventId: number | null,
    clientInstanceId: string | null,
  ): SseReplayResult<TPayload> {
    if (clientInstanceId !== null && clientInstanceId !== this.instanceId) {
      return this.gapResult("instance_mismatch");
    }

    if (lastEventId === null) {
      return this.replayResult([], null);
    }

    if (this.ring.length === 0) {
      if (lastEventId <= this.latestId) {
        return this.replayResult([], null);
      }
      return this.gapResult("ring_gap");
    }

    const oldestId = this.ring[0]?.id;
    if (oldestId === undefined) {
      return this.replayResult([], null);
    }

    if (lastEventId < oldestId - 1) {
      return this.gapResult("ring_gap");
    }

    return this.replayResult(
      this.ring.filter((event) => event.id > lastEventId),
      null,
    );
  }

  replayFromCursor(cursor: SseResumeCursor): SseReplayResult<TPayload> {
    return this.replaySince(cursor.lastEventId, cursor.instanceId);
  }

  private replayResult(
    events: Array<SseReplayEvent<TPayload>>,
    gapReason: SnapshotRefetchReason | null,
  ): SseReplayResult<TPayload> {
    return {
      events,
      gap: gapReason !== null,
      gapReason,
      snapshotRefetch: gapReason !== null,
      latestId: this.latestId,
      instanceId: this.instanceId,
      streamMeta: this.streamMeta,
    };
  }

  private gapResult(gapReason: SnapshotRefetchReason): SseReplayResult<TPayload> {
    return this.replayResult([], gapReason);
  }

  private trimRing(): void {
    const overflow = this.ring.length - this.ringMaxlen;
    if (overflow > 0) {
      this.ring.splice(0, overflow);
    }
  }
}
