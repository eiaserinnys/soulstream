import type { EventOutbox, EventOutboxBatch } from "./event_outbox.js";

export type EventAppendAck = {
  type: "event_append_ack";
  stream_id: string;
  acked_through: number;
  events: Array<{ source_seq: number; event_id: number }>;
};

export class EventOutboxPump {
  private sender?: (batch: EventOutboxBatch) => Promise<void>;
  private inFlight?: EventOutboxBatch;
  private generation = 0;
  private flushScheduled = false;

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

  private async flush(): Promise<void> {
    const sender = this.sender;
    if (!sender || this.inFlight) return;
    const generation = this.generation;
    const batch = await this.outbox.readBatch();
    if (!batch || sender !== this.sender || generation !== this.generation) return;
    this.inFlight = batch;
    try {
      await sender(batch);
    } catch (error) {
      if (generation === this.generation) this.onError(error);
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
