import type {
  EventAppendAck as WireEventAppendAck,
  EventCanonicalExecutionOwnershipProjection,
  EventCanonicalExecutionRegistrationProjection,
} from "@soulstream/wire-schema";
import type { EventOutboxBatch } from "./event_outbox.js";
import type {
  EventOutboxQuarantineInput,
  EventOutboxQuarantineResult,
} from "./event_outbox_quarantine.js";

export type EventOutboxPumpStore = {
  readonly streamId: string;
  readonly ackedSeq: number;
  onAppend(listener: () => void): () => void;
  readBatch(maxEvents?: number): Promise<EventOutboxBatch | null>;
  acknowledge(streamId: string, ackedThrough: number): Promise<void>;
  quarantineHead?(input: EventOutboxQuarantineInput): Promise<EventOutboxQuarantineResult>;
};

export type EventIngressRejection = {
  type: "error";
  command_type: "event_append_batch";
  status: number;
  code: string;
  retryable: boolean;
  message?: string;
  stream_id: string;
  source_seq: number;
};

type EventAppendAckEvent = WireEventAppendAck["events"][number];

export type EventAppendAck = Pick<
  WireEventAppendAck,
  "type" | "stream_id" | "acked_through"
> & { events: Array<EventAppendAcknowledgement | EventAppendDeadLetterAcknowledgement> };

export type EventAppendDeadLetterAcknowledgement =
  Extract<EventAppendAckEvent, { dead_letter: unknown }>;

export type EventAppendAcknowledgement =
  Extract<EventAppendAckEvent, { event_id: number }>;

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

export class EventAcknowledgementTimeoutError extends Error {
  /** Durable: the outbox replays on reconnect, so the caller may retry. */
  readonly retryable = true;

  constructor(readonly sourceSeq: number, readonly timeoutMs: number) {
    super(
      `event outbox source_seq ${sourceSeq} was not acknowledged within ${timeoutMs}ms`,
    );
    this.name = "EventAcknowledgementTimeoutError";
  }
}

export class EventOutboxQuarantinedError extends Error {
  constructor(
    readonly sourceSeq: number,
    readonly code: string,
    readonly quarantinedAt: string,
    message: string,
  ) {
    super(message);
  }
}

export type EventOutboxPumpOptions = {
  /** Orders local runner consumption before the same durable batch is published upstream. */
  beforePublish?: (batch: EventOutboxBatch) => Promise<void>;
  rejectionThreshold?: number;
  /** Delay before re-sending a batch the far side rejected as retryable. */
  retryFlushDelayMs?: number;
  /**
   * Deadline for an upstream acknowledgement. Waiters used to have none, so an
   * upstream that never acknowledged wedged every caller — and the maintenance
   * lane that called them — permanently (260820 incident).
   */
  acknowledgementTimeoutMs?: number;
  now?: () => Date;
  /** Optional polling for streams whose append notifications can be lost. */
  watchdog?: {
    intervalMs: number;
    retryAfterMs: number;
    onSend: (details: { streamId: string; sourceSeq: number; waitedMs: number }) => void;
  };
  onQuarantine?: (result: EventOutboxQuarantineResult) => void;
};

export interface EventOutboxPumpTransport {
  connect(sender: (batch: EventOutboxBatch) => Promise<void>): Promise<boolean> | void;
  disconnect(): void;
  isAck(value: unknown): value is EventAppendAck;
  handleAck(ack: EventAppendAck): Promise<void>;
  isRejection(value: unknown): value is EventIngressRejection;
  handleRejection(rejection: EventIngressRejection): Promise<EventOutboxQuarantineResult | null>;
}

export function isValidEventAppendAck(value: EventAppendAck): boolean {
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

export function isDeadLetterAcknowledgement(
  value: EventAppendAcknowledgement | EventAppendDeadLetterAcknowledgement,
): value is EventAppendDeadLetterAcknowledgement {
  return "dead_letter" in value
    && Boolean(value.dead_letter && typeof value.dead_letter === "object");
}

export function deadLetterError(
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
  if (
    value.rejection_reason !== undefined
    && typeof value.rejection_reason !== "string"
  ) return false;
  if (!isValidCanonicalExecutionRegistration(
    value.canonical_execution_registration,
  )) return false;
  if (!isValidCanonicalExecutionOwnership(value.canonical_execution_ownership)) return false;
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

function isValidCanonicalExecutionRegistration(
  value: EventCanonicalExecutionRegistrationProjection | null | undefined,
): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "object"
    && typeof value.registration_id === "string"
    && value.registration_id.length > 0
    && typeof value.execution_command_id === "string"
    && value.execution_command_id.length > 0;
}

function isValidCanonicalExecutionOwnership(
  value: EventCanonicalExecutionOwnershipProjection | null | undefined,
): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "object"
    && Number.isSafeInteger(value.ownership_generation)
    && value.ownership_generation > 0
    && ["runner_process", "adopted_runner", "in_process"].includes(value.owner_kind)
    && typeof value.manifest_id === "string"
    && value.manifest_id.length > 0
    && (value.runtime_env_identity === undefined
      || (typeof value.runtime_env_identity === "string" && value.runtime_env_identity.length > 0))
    && (value.registration_id === null || typeof value.registration_id === "string")
    && (value.pid === null || (Number.isSafeInteger(value.pid) && value.pid > 0))
    && (value.start_identity === null || typeof value.start_identity === "string")
    && (value.execution_command_id === null
      || typeof value.execution_command_id === "string")
    && ["reserved", "identity_proven", "active", "terminal", "failed"]
      .includes(value.phase)
    && (value.failure_reason === null || typeof value.failure_reason === "string");
}
