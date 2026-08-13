import type { EventOutboxBatch, EventOutboxRecord } from "./event_outbox.js";

export type EventOutboxPumpStore = {
  readonly streamId: string;
  readonly ackedSeq: number;
  onAppend(listener: () => void): () => void;
  readBatch(): Promise<EventOutboxBatch | null>;
  acknowledge(streamId: string, ackedThrough: number): Promise<void>;
};

export type EventAppendAck = {
  type: "event_append_ack";
  stream_id: string;
  acked_through: number;
  events: Array<EventAppendAcknowledgement | EventAppendDeadLetterAcknowledgement>;
};

export type EventAppendDeadLetterAcknowledgement = {
  source_seq: number;
  dead_letter: {
    code: string;
    reason: string;
    rejected_at: string;
  };
};

export type EventCanonicalSessionProjection = {
  status: string;
  termination_reason: string | null;
  termination_detail: string | null;
  review_state: string;
  last_assistant_text: string | null;
  termination_event_id: number | null;
  updated_at: string;
  last_event_id: number | null;
};

export type EventAppendAcknowledgement = {
  source_seq: number;
  event_id: number;
  effect_application?: {
    applied: boolean;
    canonical_session: EventCanonicalSessionProjection;
  };
};

export class EventOutboxDeadLetterError extends Error {
  constructor(
    readonly sourceSeq: number,
    readonly code: string,
    readonly rejectedAt: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EventOutboxPumpTransport {
  connect(sender: (batch: EventOutboxBatch) => Promise<void>): void;
  disconnect(): void;
  isAck(value: unknown): value is EventAppendAck;
  handleAck(ack: EventAppendAck): Promise<void>;
}

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
    Set<{
      resolve(acknowledgement: EventAppendAcknowledgement): void;
      reject(error: EventOutboxDeadLetterError): void;
    }>
  >();
  private readonly recentAcknowledgements = new Map<number, EventAppendAcknowledgement>();
  private readonly recentDeadLetters = new Map<
    number,
    EventAppendDeadLetterAcknowledgement
  >();
  private readonly latestAcknowledgementBySession = new Map<
    string,
    { sourceSeq: number; acknowledgement: EventAppendAcknowledgement }
  >();

  constructor(
    private readonly outbox: EventOutboxPumpStore,
    private readonly onError: (error: unknown) => void,
  ) {
    outbox.onAppend(() => this.notifyAvailable());
  }

  get streamId(): string {
    return this.outbox.streamId;
  }

  // Phase 3 uses this as the content-free IPC doorbell after the runner has
  // durably appended in another process. The pump still reads the canonical
  // record from its store; no event payload crosses this notification seam.
  notifyAvailable(): void {
    this.scheduleFlush();
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
    const immediate = this.takeImmediateAcknowledgement(record);
    if (immediate) return immediate.event_id;
    return (await this.waitForDeferredAcknowledgement(record)).event_id;
  }

  async waitForAcknowledgementResult(
    record: Pick<EventOutboxRecord, "stream_id" | "source_seq" | "session_id">,
  ): Promise<EventAppendAcknowledgement> {
    const immediate = this.takeImmediateAcknowledgement(record);
    if (immediate) return immediate;
    return await this.waitForDeferredAcknowledgement(record);
  }

  private takeImmediateAcknowledgement(
    record: Pick<EventOutboxRecord, "stream_id" | "source_seq" | "session_id">,
  ): EventAppendAcknowledgement | undefined {
    if (record.stream_id !== this.outbox.streamId) {
      throw new Error("event outbox acknowledgement target stream mismatch");
    }
    const deadLetter = this.recentDeadLetters.get(record.source_seq);
    if (deadLetter) {
      this.recentDeadLetters.delete(record.source_seq);
      throw deadLetterError(deadLetter);
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
      return completed.acknowledgement;
    }
    return undefined;
  }

  private async waitForDeferredAcknowledgement(
    record: Pick<EventOutboxRecord, "source_seq" | "session_id">,
  ): Promise<EventAppendAcknowledgement> {
    const acknowledgement = await new Promise<EventAppendAcknowledgement>((resolve, reject) => {
      const waiters = this.acknowledgementWaiters.get(record.source_seq) ?? new Set();
      waiters.add({ resolve, reject });
      this.acknowledgementWaiters.set(record.source_seq, waiters);
    });
    const latest = this.latestAcknowledgementBySession.get(record.session_id);
    if (latest?.sourceSeq === record.source_seq) {
      this.latestAcknowledgementBySession.delete(record.session_id);
    }
    return acknowledgement;
  }

  async handleAck(ack: EventAppendAck): Promise<void> {
    if (!isValidAck(ack)) throw new Error("invalid event_append_ack frame");
    if (ack.stream_id !== this.outbox.streamId) {
      throw new Error("event_append_ack stream mismatch");
    }
    const durableAckedThrough = this.outbox.ackedSeq;
    const batch = this.inFlight;
    if (!batch) {
      if (ack.acked_through <= durableAckedThrough) return;
      throw new Error("event_append_ack has no in-flight batch");
    }
    const firstSeq = batch.events[0].source_seq;
    if (ack.acked_through < firstSeq) return;
    const lastSeq = batch.events.at(-1)!.source_seq;
    if (ack.acked_through !== lastSeq || ack.events.length !== batch.events.length) {
      throw new Error("event_append_ack does not cover the in-flight batch");
    }
    for (let index = 0; index < batch.events.length; index += 1) {
      if (ack.events[index]!.source_seq !== batch.events[index]!.source_seq) {
        throw new Error("event_append_ack source_seq mapping differs from in-flight batch");
      }
    }
    if (ack.acked_through > durableAckedThrough) {
      await this.outbox.acknowledge(ack.stream_id, ack.acked_through);
    }
    for (let index = 0; index < batch.events.length; index += 1) {
      const record = batch.events[index]!;
      const acknowledgement = ack.events[index]!;
      const waiters = this.acknowledgementWaiters.get(record.source_seq);
      if (isDeadLetterAcknowledgement(acknowledgement)) {
        this.recentDeadLetters.set(record.source_seq, acknowledgement);
        if (!waiters) continue;
        this.acknowledgementWaiters.delete(record.source_seq);
        this.recentDeadLetters.delete(record.source_seq);
        const error = deadLetterError(acknowledgement);
        for (const waiter of waiters) waiter.reject(error);
        continue;
      }
      this.recentAcknowledgements.set(record.source_seq, acknowledgement);
      this.latestAcknowledgementBySession.set(record.session_id, {
        sourceSeq: record.source_seq,
        acknowledgement,
      });
      if (!waiters) continue;
      this.acknowledgementWaiters.delete(record.source_seq);
      this.recentAcknowledgements.delete(record.source_seq);
      if (
        this.latestAcknowledgementBySession.get(record.session_id)?.sourceSeq
        === record.source_seq
      ) {
        this.latestAcknowledgementBySession.delete(record.session_id);
      }
      for (const waiter of waiters) waiter.resolve(acknowledgement);
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
    while (this.recentDeadLetters.size > RECENT_ACKNOWLEDGEMENT_LIMIT) {
      const oldest = this.recentDeadLetters.keys().next().value;
      if (oldest === undefined) return;
      this.recentDeadLetters.delete(oldest);
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
      && (isDeadLetterAcknowledgement(event)
        ? typeof event.dead_letter.code === "string"
          && typeof event.dead_letter.reason === "string"
          && typeof event.dead_letter.rejected_at === "string"
        : Number.isSafeInteger(event.event_id) && event.event_id > 0
          && isValidEffectApplication(event.effect_application)));
}

function isDeadLetterAcknowledgement(
  value: EventAppendAcknowledgement | EventAppendDeadLetterAcknowledgement,
): value is EventAppendDeadLetterAcknowledgement {
  return "dead_letter" in value
    && Boolean(value.dead_letter && typeof value.dead_letter === "object");
}

function deadLetterError(
  acknowledgement: EventAppendDeadLetterAcknowledgement,
): EventOutboxDeadLetterError {
  return new EventOutboxDeadLetterError(
    acknowledgement.source_seq,
    acknowledgement.dead_letter.code,
    acknowledgement.dead_letter.rejected_at,
    acknowledgement.dead_letter.reason,
  );
}

function isValidEffectApplication(
  value: EventAppendAcknowledgement["effect_application"],
): boolean {
  if (value === undefined) return true;
  if (typeof value.applied !== "boolean") return false;
  const session = value.canonical_session;
  return Boolean(session && typeof session === "object"
    && typeof session.status === "string"
    && (session.termination_reason === null || typeof session.termination_reason === "string")
    && (session.termination_detail === null || typeof session.termination_detail === "string")
    && typeof session.review_state === "string"
    && (session.last_assistant_text === null || typeof session.last_assistant_text === "string")
    && (session.termination_event_id === null
      || Number.isSafeInteger(session.termination_event_id))
    && typeof session.updated_at === "string"
    && (session.last_event_id === null || Number.isSafeInteger(session.last_event_id)));
}
