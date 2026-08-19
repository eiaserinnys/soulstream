import { sanitizePgJsonValue, sanitizePgText } from "./pg_text_sanitizer.js";
import type {
  EventAppendBatch,
  EventIngressEnvelope,
  EventSessionEffect,
} from "./event_ingress_contract.js";
import {
  assertExactKeys,
  booleanValue,
  EventIngressValidationError,
  isRecord,
  isoTimestamp,
  nonEmptyString,
  nullableNonEmptyString,
  nullablePositiveInteger,
  nullableString,
  positiveInteger,
  recordValue,
  requiredUuid,
  stringValue,
} from "./event_ingress_validation.js";

export type {
  CommittedIngressEvent,
  DeadLetteredIngressEvent,
  EventAppendAck,
  EventAppendAcknowledgement,
  EventAppendBatch,
  EventCanonicalExecutionOwnershipProjection,
  EventCanonicalSessionProjection,
  EventIngressEnvelope,
  EventIngressResult,
  EventSessionEffect,
  EventSessionEffectApplication,
  EventSessionEffectApplicationWire,
} from "./event_ingress_contract.js";
export { isEventAppendBatchFrame } from "./event_ingress_contract.js";
export { EventIngressValidationError } from "./event_ingress_validation.js";

export const EVENT_INGRESS_PROTOCOL_VERSION = 1;
export const EVENT_INGRESS_MAX_EVENTS = 64;
export const EVENT_INGRESS_MAX_BATCH_FRAME_BYTES = 256 * 1024;
export const EVENT_INGRESS_MAX_SINGLE_EVENT_FRAME_BYTES = 2 * 1024 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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
  if (value.kind === "execution_reserve") {
    assertExactKeys(
      value,
      [
        "kind", "ownership_generation", "owner_kind", "manifest_id",
        "runtime_env_identity", "updated_at",
      ],
      field,
    );
    const ownerKind = nonEmptyString(value.owner_kind, `${field}.owner_kind`);
    if (!["runner_process", "adopted_runner", "in_process"].includes(ownerKind)) {
      throw new EventIngressValidationError(`${field}.owner_kind is invalid`);
    }
    return {
      kind: value.kind,
      ownership_generation: positiveInteger(
        value.ownership_generation,
        `${field}.ownership_generation`,
      ),
      owner_kind: ownerKind as "runner_process" | "adopted_runner" | "in_process",
      manifest_id: nonEmptyString(value.manifest_id, `${field}.manifest_id`),
      ...(value.runtime_env_identity === undefined
        ? {}
        : {
            runtime_env_identity: nonEmptyString(
              value.runtime_env_identity,
              `${field}.runtime_env_identity`,
            ),
          }),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind === "execution_prove") {
    assertExactKeys(
      value,
      [
        "kind", "ownership_generation", "registration_id", "pid",
        "start_identity", "execution_command_id", "updated_at",
      ],
      field,
    );
    return {
      kind: value.kind,
      ownership_generation: positiveInteger(value.ownership_generation, `${field}.ownership_generation`),
      registration_id: nonEmptyString(value.registration_id, `${field}.registration_id`),
      pid: positiveInteger(value.pid, `${field}.pid`),
      start_identity: nonEmptyString(value.start_identity, `${field}.start_identity`),
      execution_command_id: nonEmptyString(value.execution_command_id, `${field}.execution_command_id`),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind === "execution_adopt_reserve") {
    assertExactKeys(
      value,
      [
        "kind", "ownership_generation", "manifest_id", "runtime_env_identity",
        "previous_registration_id", "pid", "start_identity",
        "execution_command_id", "updated_at",
      ],
      field,
    );
    return {
      kind: value.kind,
      ownership_generation: positiveInteger(value.ownership_generation, `${field}.ownership_generation`),
      manifest_id: nonEmptyString(value.manifest_id, `${field}.manifest_id`),
      ...(value.runtime_env_identity === undefined
        ? {}
        : {
            runtime_env_identity: nonEmptyString(
              value.runtime_env_identity,
              `${field}.runtime_env_identity`,
            ),
          }),
      previous_registration_id: nonEmptyString(
        value.previous_registration_id,
        `${field}.previous_registration_id`,
      ),
      pid: positiveInteger(value.pid, `${field}.pid`),
      start_identity: nonEmptyString(value.start_identity, `${field}.start_identity`),
      execution_command_id: nonEmptyString(
        value.execution_command_id,
        `${field}.execution_command_id`,
      ),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind === "execution_activate") {
    assertExactKeys(
      value,
      ["kind", "ownership_generation", "review_state", "expected_terminal_event_id", "updated_at"],
      field,
    );
    return {
      kind: value.kind,
      ownership_generation: positiveInteger(value.ownership_generation, `${field}.ownership_generation`),
      review_state: nonEmptyString(value.review_state, `${field}.review_state`),
      ...(value.expected_terminal_event_id === undefined
        ? {}
        : {
            expected_terminal_event_id: value.expected_terminal_event_id === null
              ? null
              : positiveInteger(value.expected_terminal_event_id, `${field}.expected_terminal_event_id`),
          }),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind === "execution_fail") {
    assertExactKeys(
      value,
      ["kind", "ownership_generation", "failure_reason", "updated_at"],
      field,
    );
    return {
      kind: value.kind,
      ownership_generation: positiveInteger(value.ownership_generation, `${field}.ownership_generation`),
      failure_reason: nonEmptyString(value.failure_reason, `${field}.failure_reason`),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind === "execution_orphaned_spawn") {
    assertExactKeys(
      value,
      [
        "kind", "ownership_generation", "registration_id", "pid",
        "start_identity", "execution_command_id", "updated_at",
      ],
      field,
    );
    return {
      kind: value.kind,
      ownership_generation: positiveInteger(
        value.ownership_generation,
        `${field}.ownership_generation`,
      ),
      registration_id: nonEmptyString(value.registration_id, `${field}.registration_id`),
      pid: positiveInteger(value.pid, `${field}.pid`),
      start_identity: nonEmptyString(value.start_identity, `${field}.start_identity`),
      execution_command_id: nonEmptyString(
        value.execution_command_id,
        `${field}.execution_command_id`,
      ),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind === "execution_backfill") {
    assertExactKeys(
      value,
      [
        "kind", "first_manifest_id", "first_runtime_env_identity",
        "first_registration_id", "first_pid",
        "first_start_identity", "first_execution_command_id", "first_observed_at",
        "second_manifest_id", "second_runtime_env_identity",
        "second_registration_id", "second_pid",
        "second_start_identity", "second_execution_command_id", "second_observed_at",
        "evidence_hash", "minimum_lease_interval_ms", "probe_only", "updated_at",
      ],
      field,
    );
    const evidenceHash = nonEmptyString(value.evidence_hash, `${field}.evidence_hash`);
    if (!SHA256_PATTERN.test(evidenceHash)) {
      throw new EventIngressValidationError(`${field}.evidence_hash must be sha256`);
    }
    if ((value.first_runtime_env_identity === undefined)
      !== (value.second_runtime_env_identity === undefined)) {
      throw new EventIngressValidationError(
        `${field} runtime env identities must be supplied together`,
      );
    }
    return {
      kind: value.kind,
      first_manifest_id: nullableNonEmptyString(value.first_manifest_id, `${field}.first_manifest_id`),
      ...(value.first_runtime_env_identity === undefined
        ? {}
        : {
            first_runtime_env_identity: nullableNonEmptyString(
              value.first_runtime_env_identity,
              `${field}.first_runtime_env_identity`,
            ),
          }),
      first_registration_id: nullableNonEmptyString(value.first_registration_id, `${field}.first_registration_id`),
      first_pid: nullablePositiveInteger(value.first_pid, `${field}.first_pid`),
      first_start_identity: nullableNonEmptyString(value.first_start_identity, `${field}.first_start_identity`),
      first_execution_command_id: nullableNonEmptyString(
        value.first_execution_command_id,
        `${field}.first_execution_command_id`,
      ),
      first_observed_at: isoTimestamp(value.first_observed_at, `${field}.first_observed_at`),
      second_manifest_id: nullableNonEmptyString(value.second_manifest_id, `${field}.second_manifest_id`),
      ...(value.second_runtime_env_identity === undefined
        ? {}
        : {
            second_runtime_env_identity: nullableNonEmptyString(
              value.second_runtime_env_identity,
              `${field}.second_runtime_env_identity`,
            ),
          }),
      second_registration_id: nullableNonEmptyString(value.second_registration_id, `${field}.second_registration_id`),
      second_pid: nullablePositiveInteger(value.second_pid, `${field}.second_pid`),
      second_start_identity: nullableNonEmptyString(value.second_start_identity, `${field}.second_start_identity`),
      second_execution_command_id: nullableNonEmptyString(
        value.second_execution_command_id,
        `${field}.second_execution_command_id`,
      ),
      second_observed_at: isoTimestamp(value.second_observed_at, `${field}.second_observed_at`),
      evidence_hash: evidenceHash,
      minimum_lease_interval_ms: positiveInteger(
        value.minimum_lease_interval_ms,
        `${field}.minimum_lease_interval_ms`,
      ),
      probe_only: booleanValue(value.probe_only, `${field}.probe_only`),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind === "runner_terminal_fact") {
    assertExactKeys(
      value,
      [
        "kind", "ownership_generation", "execution_command_id", "runner_fact",
        "termination_detail", "review_state", "last_assistant_text", "updated_at",
      ],
      field,
    );
    const runnerFact = nonEmptyString(value.runner_fact, `${field}.runner_fact`);
    if (!["completed", "failed", "reaped", "closed"].includes(runnerFact)) {
      throw new EventIngressValidationError(`${field}.runner_fact is invalid`);
    }
    return {
      kind: value.kind,
      ownership_generation: positiveInteger(value.ownership_generation, `${field}.ownership_generation`),
      execution_command_id: nonEmptyString(
        value.execution_command_id,
        `${field}.execution_command_id`,
      ),
      runner_fact: runnerFact as "completed" | "failed" | "reaped" | "closed",
      termination_detail: nullableString(value.termination_detail, `${field}.termination_detail`),
      review_state: nonEmptyString(value.review_state, `${field}.review_state`),
      ...(value.last_assistant_text === undefined
        ? {}
        : { last_assistant_text: nullableString(value.last_assistant_text, `${field}.last_assistant_text`) }),
      updated_at: isoTimestamp(value.updated_at, `${field}.updated_at`),
    };
  }
  if (value.kind === "recovered_runner_terminal_fact") {
    assertExactKeys(
      value,
      [
        "kind", "manifest_id", "registration_id", "pid", "start_identity",
        "execution_command_id", "runner_fact", "termination_detail", "review_state",
        "last_assistant_text", "updated_at",
      ],
      field,
    );
    const runnerFact = nonEmptyString(value.runner_fact, `${field}.runner_fact`);
    if (!["completed", "failed", "reaped", "closed"].includes(runnerFact)) {
      throw new EventIngressValidationError(`${field}.runner_fact is invalid`);
    }
    return {
      kind: value.kind,
      manifest_id: nonEmptyString(value.manifest_id, `${field}.manifest_id`),
      registration_id: nonEmptyString(value.registration_id, `${field}.registration_id`),
      pid: positiveInteger(value.pid, `${field}.pid`),
      start_identity: nonEmptyString(value.start_identity, `${field}.start_identity`),
      execution_command_id: nonEmptyString(
        value.execution_command_id,
        `${field}.execution_command_id`,
      ),
      runner_fact: runnerFact as "completed" | "failed" | "reaped" | "closed",
      termination_detail: nullableString(value.termination_detail, `${field}.termination_detail`),
      review_state: nonEmptyString(value.review_state, `${field}.review_state`),
      ...(value.last_assistant_text === undefined
        ? {}
        : { last_assistant_text: nullableString(value.last_assistant_text, `${field}.last_assistant_text`) }),
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
