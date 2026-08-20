import type { EventOutboxBatch, EventOutboxRecord } from "./event_outbox.js";
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

export type EventCanonicalExecutionOwnershipProjection = {
  ownership_generation: number;
  owner_kind: "runner_process" | "adopted_runner" | "in_process";
  manifest_id: string;
  runtime_env_identity?: string;
  registration_id: string | null;
  pid: number | null;
  start_identity: string | null;
  execution_command_id: string | null;
  phase: "reserved" | "identity_proven" | "active" | "terminal" | "failed";
  failure_reason: string | null;
};

export type EventAppendAcknowledgement = {
  source_seq: number;
  event_id: number;
  effect_application?: {
    applied: boolean;
    canonical_session: EventCanonicalSessionProjection;
    canonical_execution_ownership?: EventCanonicalExecutionOwnershipProjection | null;
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
