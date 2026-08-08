import type {
  EventOutbox,
  EventOutboxBatch,
  EventOutboxRecord,
} from "./event_outbox.js";

export type EventAppendAck = {
  type: "event_append_ack";
  stream_id: string;
  acked_through: number;
  events: Array<{ source_seq: number; event_id: number }>;
};

// An ACK may arrive in the microtask between EventOutbox.append() returning and
// a DB-event-ID barrier registering its waiter. One batch has at most 64 rows;
// two batches retain enough exact results to bridge that scheduling race while
// the per-session cache below remains the long-lived turn-boundary source.
const RECENT_ACKNOWLEDGEMENT_LIMIT = 128;

export class EventOutboxPump {
  private sender?: (batch: EventOutboxBatch) => Promise<void>;
  private inFlight?: EventOutboxBatch;
  private generation = 0;
  private flushScheduled = false;
  private flushActive = false;
  private flushAgain = false;
  private readonly acknowledgementWaiters = new Map<
    number,
    Set<(eventId: number) => void>
  >();
  private readonly recentAcknowledgements = new Map<number, number>();
  private readonly latestAcknowledgementBySession = new Map<
    string,
    { sourceSeq: number; eventId: number }
  >();

  constructor(
    private readonly outbox: EventOutbox,
    private readonly onError: (error: unknown) => void,
  ) {
    outbox.onAppend(() => this.scheduleFlush());
  }

  connect(sender: (batch: EventOutboxBatch) => Promise<void>): void {
    this.generation += 1;
    this.sender = sender;
    this.inFlight = undefined;
    this.scheduleFlush();
  }

  disconnect(): void {
    this.generation += 1;
    this.sender = undefined;
    this.inFlight = undefined;
  }

  isAck(value: unknown): value is EventAppendAck {
    return Boolean(value && typeof value === "object"
      && (value as Record<string, unknown>).type === "event_append_ack");
  }

  async waitForAcknowledgement(
    record: Pick<EventOutboxRecord, "stream_id" | "source_seq" | "session_id">,
  ): Promise<number> {
    if (record.stream_id !== this.outbox.streamId) {
      throw new Error("event outbox acknowledgement target stream mismatch");
    }
    const exact = this.recentAcknowledgements.get(record.source_seq);
    if (exact !== undefined) {
      this.recentAcknowledgements.delete(record.source_seq);
      const latest = this.latestAcknowledgementBySession.get(record.session_id);
      if (latest?.sourceSeq === record.source_seq) {
        this.latestAcknowledgementBySession.delete(record.session_id);
      }
      return exact;
    }
    const completed = this.latestAcknowledgementBySession.get(record.session_id);
    if (completed?.sourceSeq === record.source_seq) {
      this.latestAcknowledgementBySession.delete(record.session_id);
      return completed.eventId;
    }

    const eventId = await new Promise<number>((resolve) => {
      const waiters = this.acknowledgementWaiters.get(record.source_seq) ?? new Set();
      waiters.add(resolve);
      this.acknowledgementWaiters.set(record.source_seq, waiters);
    });
    const latest = this.latestAcknowledgementBySession.get(record.session_id);
    if (latest?.sourceSeq === record.source_seq) {
      this.latestAcknowledgementBySession.delete(record.session_id);
    }
    return eventId;
  }

  async handleAck(ack: EventAppendAck): Promise<void> {
    if (!isValidAck(ack)) throw new Error("invalid event_append_ack frame");
    if (ack.stream_id !== this.outbox.streamId) {
      throw new Error("event_append_ack stream mismatch");
    }
    if (ack.acked_through <= this.outbox.ackedSeq) return;
    const batch = this.inFlight;
    if (!batch) throw new Error("event_append_ack has no in-flight batch");
    const lastSeq = batch.events.at(-1)!.source_seq;
    if (ack.acked_through !== lastSeq || ack.events.length !== batch.events.length) {
      throw new Error("event_append_ack does not cover the in-flight batch");
    }
    for (let index = 0; index < batch.events.length; index += 1) {
      if (ack.events[index]!.source_seq !== batch.events[index]!.source_seq) {
        throw new Error("event_append_ack source_seq mapping differs from in-flight batch");
      }
    }
    await this.outbox.acknowledge(ack.stream_id, ack.acked_through);
    for (let index = 0; index < batch.events.length; index += 1) {
      const record = batch.events[index]!;
      const eventId = ack.events[index]!.event_id;
      this.recentAcknowledgements.set(record.source_seq, eventId);
      this.latestAcknowledgementBySession.set(record.session_id, {
        sourceSeq: record.source_seq,
        eventId,
      });
      const waiters = this.acknowledgementWaiters.get(record.source_seq);
      if (!waiters) continue;
      this.acknowledgementWaiters.delete(record.source_seq);
      this.recentAcknowledgements.delete(record.source_seq);
      if (
        this.latestAcknowledgementBySession.get(record.session_id)?.sourceSeq
        === record.source_seq
      ) {
        this.latestAcknowledgementBySession.delete(record.session_id);
      }
      for (const resolve of waiters) resolve(eventId);
    }
    this.trimRecentAcknowledgements();
    this.inFlight = undefined;
    this.scheduleFlush();
  }

  async drainScheduled(): Promise<void> {
    while (this.flushScheduled) await Promise.resolve();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush().catch(this.onError);
    });
  }

  private trimRecentAcknowledgements(): void {
    while (this.recentAcknowledgements.size > RECENT_ACKNOWLEDGEMENT_LIMIT) {
      const oldest = this.recentAcknowledgements.keys().next().value;
      if (oldest === undefined) return;
      this.recentAcknowledgements.delete(oldest);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushActive) {
      this.flushAgain = true;
      return;
    }
    const sender = this.sender;
    if (!sender || this.inFlight) return;
    this.flushActive = true;
    try {
      const generation = this.generation;
      const batch = await this.outbox.readBatch();
      if (!batch || sender !== this.sender || generation !== this.generation) return;
      this.inFlight = batch;
      try {
        await sender(batch);
      } catch (error) {
        if (generation === this.generation) this.onError(error);
      }
    } finally {
      this.flushActive = false;
      if (this.flushAgain) {
        this.flushAgain = false;
        this.scheduleFlush();
      }
    }
  }
}

function isValidAck(value: EventAppendAck): boolean {
  return typeof value.stream_id === "string"
    && Number.isSafeInteger(value.acked_through) && value.acked_through > 0
    && Array.isArray(value.events) && value.events.length > 0
    && value.events.every((event) =>
      Number.isSafeInteger(event.source_seq) && event.source_seq > 0
      && Number.isSafeInteger(event.event_id) && event.event_id > 0);
}
