import type { EventOutboxBatch, EventOutboxRecord } from "./event_outbox.js";
import type { EventOutboxQuarantineResult } from "./event_outbox_quarantine.js";
import {
  deadLetterError,
  EventAcknowledgementTimeoutError,
  EventOutboxQuarantinedError,
  isDeadLetterAcknowledgement,
  isValidEventAppendAck,
  type EventAppendAck,
  type EventAppendAcknowledgement,
  type EventAppendDeadLetterAcknowledgement,
  type EventIngressRejection,
  type EventOutboxPumpOptions,
  type EventOutboxPumpStore,
} from "./event_outbox_pump_protocol.js";

export {
  EventAcknowledgementTimeoutError,
  EventOutboxDeadLetterError,
  EventOutboxQuarantinedError,
  type EventAppendAck,
  type EventAppendAcknowledgement,
  type EventAppendDeadLetterAcknowledgement,
  type EventCanonicalSessionProjection,
  type EventIngressRejection,
  type EventOutboxPumpOptions,
  type EventOutboxPumpStore,
  type EventOutboxPumpTransport,
} from "./event_outbox_pump_protocol.js";

// An ACK may arrive in the microtask between EventOutbox.append() returning and
// a DB-event-ID barrier registering its waiter. One batch has at most 64 rows;
// two batches retain enough exact results to bridge that scheduling race while
// the per-session cache below remains the long-lived turn-boundary source.
const RECENT_ACKNOWLEDGEMENT_LIMIT = 128;
const DEFAULT_REJECTION_THRESHOLD = 3;
const DEFAULT_RETRY_FLUSH_DELAY_MS = 1_000;
/**
 * Long enough to ride out an upstream reconnect (the outbox replays durably on
 * reconnect, so the same source_seq is acknowledged afterwards), short enough
 * that no caller can be parked for the life of the process.
 */
const DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;

export class EventOutboxPump {
  private sender?: (batch: EventOutboxBatch) => Promise<void>;
  private inFlight?: EventOutboxBatch;
  private generation = 0;
  private flushScheduled = false;
  private flushActive = false;
  private flushAgain = false;
  private readonly retryFlushTimers = new Set<ReturnType<typeof setTimeout>>();
  private singleEventProbe = false;
  private readiness?: { generation: number; resolve(value: boolean): void };
  private rejectionState?: {
    streamId: string;
    sourceSeq: number;
    code: string;
    attempts: number;
  };
  private readonly acknowledgementWaiters = new Map<
    number,
    Set<{
      resolve(acknowledgement: EventAppendAcknowledgement): void;
      reject(error: Error): void;
    }>
  >();
  private readonly recentAcknowledgements = new Map<number, EventAppendAcknowledgement>();
  private readonly recentDeadLetters = new Map<
    number,
    EventAppendDeadLetterAcknowledgement
  >();
  private readonly recentQuarantines = new Map<number, EventOutboxQuarantinedError>();
  private readonly latestAcknowledgementBySession = new Map<
    string,
    { sourceSeq: number; acknowledgement: EventAppendAcknowledgement }
  >();

  constructor(
    private readonly outbox: EventOutboxPumpStore,
    private readonly onError: (error: unknown) => void,
    private readonly options: EventOutboxPumpOptions = {},
  ) {
    const threshold = options.rejectionThreshold ?? DEFAULT_REJECTION_THRESHOLD;
    if (!Number.isSafeInteger(threshold) || threshold <= 0) {
      throw new Error("event outbox rejection threshold must be a positive integer");
    }
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

  connect(sender: (batch: EventOutboxBatch) => Promise<void>): Promise<boolean> {
    this.resolveReadiness(false);
    this.generation += 1;
    this.sender = sender;
    this.inFlight = undefined;
    const generation = this.generation;
    const ready = new Promise<boolean>((resolve) => {
      this.readiness = { generation, resolve };
    });
    this.scheduleFlush();
    return ready;
  }

  disconnect(): void {
    this.resolveReadiness(false);
    this.generation += 1;
    this.sender = undefined;
    this.inFlight = undefined;
    for (const timer of this.retryFlushTimers) clearTimeout(timer);
    this.retryFlushTimers.clear();
  }

  isAck(value: unknown): value is EventAppendAck {
    return Boolean(value && typeof value === "object"
      && (value as Record<string, unknown>).type === "event_append_ack");
  }

  isRejection(value: unknown): value is EventIngressRejection {
    if (!value || typeof value !== "object") return false;
    const frame = value as Record<string, unknown>;
    return frame.type === "error"
      && frame.command_type === "event_append_batch"
      && typeof frame.code === "string"
      && typeof frame.retryable === "boolean"
      && typeof frame.stream_id === "string"
      && Number.isSafeInteger(frame.source_seq)
      && Number(frame.source_seq) > 0;
  }

  async handleRejection(
    rejection: EventIngressRejection,
  ): Promise<EventOutboxQuarantineResult | null> {
    if (!this.isRejection(rejection)) {
      throw new Error("invalid event ingress rejection frame");
    }
    if (rejection.stream_id !== this.outbox.streamId) {
      throw new Error("event ingress rejection stream mismatch");
    }
    const batch = this.inFlight;
    if (!batch) {
      if (rejection.source_seq <= this.outbox.ackedSeq) return null;
      throw new Error("event ingress rejection has no in-flight batch");
    }
    const first = batch.events[0]!;
    const last = batch.events.at(-1)!;
    if (rejection.source_seq < first.source_seq || rejection.source_seq > last.source_seq) {
      throw new Error("event ingress rejection source_seq is outside the in-flight batch");
    }
    if (rejection.retryable) {
      // Nothing clears an in-flight batch except an ACK or a reconnect, so a
      // retryable rejection would otherwise stall this stream until the socket
      // happened to drop. We own the durable copy — reclaim the batch and send
      // it again ourselves. orch must not retry its own copy; two owners of one
      // retry produce two ACKs, and the second finds no batch to match.
      this.rejectionState = undefined;
      this.inFlight = undefined;
      this.scheduleRetryFlush();
      return null;
    }
    if (rejection.code !== "EVENT_INGRESS_PROTOCOL_CONFLICT") {
      this.rejectionState = undefined;
      return null;
    }
    if (rejection.source_seq !== first.source_seq) {
      this.singleEventProbe = true;
      this.rejectionState = undefined;
      return null;
    }

    const previous = this.rejectionState;
    const attempts = previous
      && previous.streamId === rejection.stream_id
      && previous.sourceSeq === rejection.source_seq
      && previous.code === rejection.code
      ? previous.attempts + 1
      : 1;
    this.rejectionState = {
      streamId: rejection.stream_id,
      sourceSeq: rejection.source_seq,
      code: rejection.code,
      attempts,
    };
    const threshold = this.options.rejectionThreshold ?? DEFAULT_REJECTION_THRESHOLD;
    if (attempts < threshold) return null;
    if (!this.outbox.quarantineHead) {
      throw new Error("event outbox store does not support automatic quarantine");
    }

    const quarantinedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const result = await this.outbox.quarantineHead({
      record: first,
      rejection: {
        code: rejection.code,
        reason: rejection.message ?? rejection.code,
      },
      attempts,
      quarantinedAt,
    });
    const error = new EventOutboxQuarantinedError(
      first.source_seq,
      rejection.code,
      quarantinedAt,
      `event outbox source_seq ${first.source_seq} quarantined after ${attempts} rejections`,
    );
    this.rejectAcknowledgementWaiters(first.source_seq, error);
    this.options.onQuarantine?.(result);
    this.rejectionState = undefined;
    this.singleEventProbe = false;
    this.disconnect();
    return result;
  }

  async waitForAcknowledgement(
    record: Pick<EventOutboxRecord, "stream_id" | "source_seq" | "session_id">,
    options: { timeoutMs?: number } = {},
  ): Promise<number> {
    const immediate = this.takeImmediateAcknowledgement(record);
    if (immediate) return immediate.event_id;
    return (await this.waitForDeferredAcknowledgement(record, options)).event_id;
  }

  async waitForAcknowledgementResult(
    record: Pick<EventOutboxRecord, "stream_id" | "source_seq" | "session_id">,
    options: { timeoutMs?: number } = {},
  ): Promise<EventAppendAcknowledgement> {
    const immediate = this.takeImmediateAcknowledgement(record);
    if (immediate) return immediate;
    return await this.waitForDeferredAcknowledgement(record, options);
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
    const quarantined = this.recentQuarantines.get(record.source_seq);
    if (quarantined) {
      this.recentQuarantines.delete(record.source_seq);
      throw quarantined;
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
    options: { timeoutMs?: number } = {},
  ): Promise<EventAppendAcknowledgement> {
    const timeoutMs = options.timeoutMs
      ?? this.options.acknowledgementTimeoutMs
      ?? DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS;
    const acknowledgement = await new Promise<EventAppendAcknowledgement>((resolve, reject) => {
      const waiters = this.acknowledgementWaiters.get(record.source_seq) ?? new Set();
      const waiter = {
        resolve: (value: EventAppendAcknowledgement) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        // Drop only this waiter; siblings on the same seq keep their own
        // deadlines, and the durable outbox still replays the record.
        const pending = this.acknowledgementWaiters.get(record.source_seq);
        pending?.delete(waiter);
        if (pending && pending.size === 0) {
          this.acknowledgementWaiters.delete(record.source_seq);
        }
        reject(new EventAcknowledgementTimeoutError(record.source_seq, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      waiters.add(waiter);
      this.acknowledgementWaiters.set(record.source_seq, waiters);
    });
    const latest = this.latestAcknowledgementBySession.get(record.session_id);
    if (latest?.sourceSeq === record.source_seq) {
      this.latestAcknowledgementBySession.delete(record.session_id);
    }
    return acknowledgement;
  }

  async handleAck(ack: EventAppendAck): Promise<void> {
    if (!isValidEventAppendAck(ack)) throw new Error("invalid event_append_ack frame");
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
    this.rejectionState = undefined;
    this.singleEventProbe = false;
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

  /**
   * Resend after a delay. A retryable rejection usually means the far side is
   * briefly unable to commit; re-sending on the next microtask would spin a hot
   * loop against it for as long as the condition lasts.
   */
  private scheduleRetryFlush(): void {
    const generation = this.generation;
    const timer = setTimeout(() => {
      this.retryFlushTimers.delete(timer);
      if (generation !== this.generation) return;
      this.scheduleFlush();
    }, this.options.retryFlushDelayMs ?? DEFAULT_RETRY_FLUSH_DELAY_MS);
    timer.unref?.();
    this.retryFlushTimers.add(timer);
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
    while (this.recentQuarantines.size > RECENT_ACKNOWLEDGEMENT_LIMIT) {
      const oldest = this.recentQuarantines.keys().next().value;
      if (oldest === undefined) return;
      this.recentQuarantines.delete(oldest);
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
      const batch = await this.outbox.readBatch(this.singleEventProbe ? 1 : undefined);
      if (sender !== this.sender || generation !== this.generation) return;
      if (!batch) {
        this.resolveReadiness(true, generation);
        return;
      }
      await this.options.beforePublish?.(batch);
      if (sender !== this.sender || generation !== this.generation) return;
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

  private resolveReadiness(value: boolean, generation = this.generation): void {
    if (!this.readiness || this.readiness.generation !== generation) return;
    const readiness = this.readiness;
    this.readiness = undefined;
    readiness.resolve(value);
  }

  private rejectAcknowledgementWaiters(sourceSeq: number, error: EventOutboxQuarantinedError): void {
    const waiters = this.acknowledgementWaiters.get(sourceSeq);
    if (!waiters) {
      this.recentQuarantines.set(sourceSeq, error);
      this.trimRecentAcknowledgements();
      return;
    }
    this.acknowledgementWaiters.delete(sourceSeq);
    for (const waiter of waiters) waiter.reject(error);
  }
}
