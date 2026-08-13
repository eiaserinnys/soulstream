import { sanitizePgJsonValue, sanitizePgText } from "./pg_text_sanitizer.js";

export const EVENT_INGRESS_PROTOCOL_VERSION = 1;
export const EVENT_INGRESS_MAX_EVENTS = 64;
export const EVENT_INGRESS_MAX_BATCH_FRAME_BYTES = 256 * 1024;
export const EVENT_INGRESS_MAX_SINGLE_EVENT_FRAME_BYTES = 2 * 1024 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export type EventSessionEffect =
  | {
      kind: "last_message";
      last_message: { type: string; preview: string; timestamp: string };
      updated_at: string;
    }
  | { kind: "set_backend_session_id"; backend_session_id: string }
  | {
      kind: "rotate_backend_session_id";
      expected_backend_session_id: string;
      backend_session_id: string;
    }
  | {
      kind: "running_transition";
      review_state: string;
      expected_terminal_event_id?: number | null;
      updated_at: string;
    }
  | {
      kind: "terminal_transition";
      status: string;
      termination_reason: string;
      termination_detail: string | null;
      review_state: string;
      last_assistant_text?: string | null;
      updated_at: string;
    }
  | {
      kind: "append_metadata";
      entry: Record<string, unknown>;
      updated_at: string;
      replace_existing_type?: string;
    };

export type EventIngressEnvelope = {
  stream_id: string;
  source_seq: number;
  session_id: string;
  event_type: string;
  payload: unknown;
  searchable_text: string | null;
  created_at: string;
  semantic_dedupe_key: string | null;
  session_effect: EventSessionEffect | null;
  payload_hash: string;
};

export type EventAppendBatch = {
  type: "event_append_batch";
  protocol_version: 1;
  stream_id: string;
  first_seq: number;
  events: EventIngressEnvelope[];
};

export type EventAppendAck = {
  type: "event_append_ack";
  stream_id: string;
  acked_through: number;
  events: EventAppendAcknowledgement[];
};

export type EventAppendAcknowledgement =
  | {
      source_seq: number;
      event_id: number;
      effect_application?: EventSessionEffectApplicationWire;
    }
  | {
      source_seq: number;
      dead_letter: {
        code: "SESSION_NOT_FOUND";
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

export type EventSessionEffectApplication = {
  applied: boolean;
  canonicalSession: EventCanonicalSessionProjection | null;
};

export type EventSessionEffectApplicationWire = {
  applied: boolean;
  canonical_session: EventCanonicalSessionProjection;
};

export type CommittedIngressEvent = {
  outcome?: "committed";
  envelope: EventIngressEnvelope;
  eventId: number;
  duplicateReceipt: boolean;
  sessionEffectApplication?: EventSessionEffectApplication;
};

export type DeadLetteredIngressEvent = {
  outcome: "dead_lettered";
  envelope: EventIngressEnvelope;
  deadLetter: {
    code: "SESSION_NOT_FOUND";
    reason: string;
    rejectedAt: string;
    path: string;
  };
};

export type EventIngressResult = CommittedIngressEvent | DeadLetteredIngressEvent;

export class EventIngressValidationError extends Error {}

export function isEventAppendBatchFrame(
  frame: Record<string, unknown>,
): boolean {
  return frame.type === "event_append_batch";
}

export function parseEventAppendBatch(
  frame: Record<string, unknown>,
): EventAppendBatch {
  if (frame.protocol_version !== EVENT_INGRESS_PROTOCOL_VERSION) {
    throw new EventIngressValidationError("unsupported event ingress protocol_version");
  }
  const streamId = requiredUuid(frame.stream_id, "stream_id");
  const firstSeq = positiveInteger(frame.first_seq, "first_seq");
  if (!Array.isArray(frame.events) || frame.events.length === 0) {
    throw new EventIngressValidationError("event_append_batch events must not be empty");
  }
  if (frame.events.length > EVENT_INGRESS_MAX_EVENTS) {
    throw new EventIngressValidationError("event_append_batch exceeds 64 events");
  }
  const frameBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
  if (
    frameBytes > EVENT_INGRESS_MAX_BATCH_FRAME_BYTES
    && (
      frame.events.length !== 1
      || frameBytes > EVENT_INGRESS_MAX_SINGLE_EVENT_FRAME_BYTES
    )
  ) {
    throw new EventIngressValidationError(
      "event_append_batch exceeds 256 KiB batch or 2 MiB single-event limit",
    );
  }

  const events = frame.events.map((value, index) => {
    if (!isRecord(value)) {
      throw new EventIngressValidationError(`events[${index}] must be an object`);
    }
    return parseEnvelope(value, streamId, firstSeq + index, index);
  });
  return {
    type: "event_append_batch",
    protocol_version: EVENT_INGRESS_PROTOCOL_VERSION,
    stream_id: streamId,
    first_seq: firstSeq,
    events,
  };
}

function parseEnvelope(
  value: Record<string, unknown>,
  streamId: string,
  expectedSeq: number,
  index: number,
): EventIngressEnvelope {
  if (requiredUuid(value.stream_id, `events[${index}].stream_id`) !== streamId) {
    throw new EventIngressValidationError(`events[${index}].stream_id differs from batch`);
  }
  const sourceSeq = positiveInteger(value.source_seq, `events[${index}].source_seq`);
  if (sourceSeq !== expectedSeq) {
    throw new EventIngressValidationError("event_append_batch source_seq must be contiguous");
  }
  const sessionId = nonEmptyString(value.session_id, `events[${index}].session_id`);
  const eventType = nonEmptyString(value.event_type, `events[${index}].event_type`);
  const createdAt = nonEmptyString(value.created_at, `events[${index}].created_at`);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new EventIngressValidationError(`events[${index}].created_at must be ISO-8601`);
  }
  const payloadHash = nonEmptyString(value.payload_hash, `events[${index}].payload_hash`);
  if (!SHA256_PATTERN.test(payloadHash)) {
    throw new EventIngressValidationError(`events[${index}].payload_hash must be sha256`);
  }
  const searchableText = nullableString(value.searchable_text, `events[${index}].searchable_text`);
  const semanticDedupeKey = nullableString(
    value.semantic_dedupe_key,
    `events[${index}].semantic_dedupe_key`,
  );
  const sessionEffect = parseSessionEffect(value.session_effect, index);
  return {
    stream_id: streamId,
    source_seq: sourceSeq,
    session_id: sessionId,
    event_type: eventType,
    payload: sanitizePgJsonValue(value.payload),
    searchable_text: searchableText === null ? null : sanitizePgText(searchableText),
    created_at: createdAt,
    semantic_dedupe_key: semanticDedupeKey === null ? null : sanitizePgText(semanticDedupeKey),
    session_effect: sessionEffect === null
      ? null
      : sanitizePgJsonValue(sessionEffect) as EventSessionEffect,
    payload_hash: payloadHash,
  };
}

function parseSessionEffect(value: unknown, index: number): EventSessionEffect | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new EventIngressValidationError(`events[${index}].session_effect kind is invalid`);
  }
  const field = `events[${index}].session_effect`;
  if (value.kind === "last_message") {
    const lastMessage = recordValue(value.last_message, `${field}.last_message`);
    return {
      kind: value.kind,
      last_message: {
        type: nonEmptyString(lastMessage.type, `${field}.last_message.type`),
        preview: stringValue(lastMessage.preview, `${field}.last_message.preview`),
        timestamp: isoTimestamp(lastMessage.timestamp, `${field}.last_message.timestamp`),
      },
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind === "set_backend_session_id") {
    return {
      kind: value.kind,
      backend_session_id: nonEmptyString(value.backend_session_id, `${field}.backend_session_id`),
    };
  }
  if (value.kind === "rotate_backend_session_id") {
    assertExactKeys(
      value,
      ["kind", "expected_backend_session_id", "backend_session_id"],
      field,
    );
    return {
      kind: value.kind,
      expected_backend_session_id: nonEmptyString(
        value.expected_backend_session_id,
        `${field}.expected_backend_session_id`,
      ),
      backend_session_id: nonEmptyString(
        value.backend_session_id,
        `${field}.backend_session_id`,
      ),
    };
  }
  if (value.kind === "running_transition") {
    assertExactKeys(
      value,
      ["kind", "review_state", "expected_terminal_event_id", "updated_at"],
      field,
    );
    return {
      kind: value.kind,
      review_state: nonEmptyString(value.review_state, `${field}.review_state`),
      ...(value.expected_terminal_event_id === undefined
        ? {}
        : {
            expected_terminal_event_id: value.expected_terminal_event_id === null
              ? null
              : positiveInteger(
                  value.expected_terminal_event_id,
                  `${field}.expected_terminal_event_id`,
                ),
          }),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind === "terminal_transition") {
    return {
      kind: value.kind,
      status: nonEmptyString(value.status, `${field}.status`),
      termination_reason: nonEmptyString(value.termination_reason, `${field}.termination_reason`),
      termination_detail: nullableString(value.termination_detail, `${field}.termination_detail`),
      review_state: nonEmptyString(value.review_state, `${field}.review_state`),
      ...(value.last_assistant_text === undefined
        ? {}
        : {
            last_assistant_text: nullableString(
              value.last_assistant_text,
              `${field}.last_assistant_text`,
            ),
          }),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind === "append_metadata") {
    return {
      kind: value.kind,
      entry: recordValue(value.entry, `${field}.entry`),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
      ...(value.replace_existing_type === undefined
        ? {}
        : { replace_existing_type: nonEmptyString(value.replace_existing_type, `${field}.replace_existing_type`) }),
    };
  }
  throw new EventIngressValidationError(`${field} kind is invalid`);
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new EventIngressValidationError(`${field} must be an object`);
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const expected = new Set(expectedKeys);
  const unexpected = Object.keys(value).filter((key) => !expected.has(key)).sort();
  if (unexpected.length > 0) {
    throw new EventIngressValidationError(
      `${field} has unexpected fields: ${unexpected.join(", ")}`,
    );
  }
}

function isoTimestamp(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(text))) {
    throw new EventIngressValidationError(`${field} must be ISO-8601`);
  }
  return text;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new EventIngressValidationError(`${field} must be string`);
  return value;
}

function requiredUuid(value: unknown, field: string): string {
  const text = nonEmptyString(value, field);
  if (!UUID_PATTERN.test(text)) throw new EventIngressValidationError(`${field} must be UUID`);
  return text;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new EventIngressValidationError(`${field} must be a positive integer`);
  }
  return value as number;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EventIngressValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new EventIngressValidationError(`${field} must be string|null`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
