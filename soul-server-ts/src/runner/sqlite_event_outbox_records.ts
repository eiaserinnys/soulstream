import { isDeepStrictEqual } from "node:util";

import {
  EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES,
  computeEventOutboxPayloadHash,
  type EventOutboxAppendInput,
  type EventOutboxBatch,
  type EventOutboxRecord,
} from "../upstream/event_outbox.js";
import {
  RUNNER_BOOTSTRAP_EVENT_TYPE,
  type RunnerBootstrapInput,
  type RunnerBootstrapRecord,
  type RunnerEventOutboxRow,
  type RunnerResumeMaterial,
} from "./sqlite_event_outbox_schema.js";
import { assertRunnerJsonValue } from "./frame_protocol.js";

export function runnerRowToBootstrap(row: RunnerEventOutboxRow): RunnerBootstrapRecord {
  const record = runnerRowToRecord(row);
  if (record.event_type !== RUNNER_BOOTSTRAP_EVENT_TYPE) {
    throw new Error("runner bootstrap event type is invalid");
  }
  validateRunnerResumeMaterial(record.payload);
  return record as RunnerBootstrapRecord;
}

export function runnerRowToRecord(row: RunnerEventOutboxRow): EventOutboxRecord {
  const record: EventOutboxRecord = {
    stream_id: row.stream_id,
    source_seq: row.source_seq,
    session_id: row.session_id,
    ...(row.execution_generation == null
      ? {}
      : { execution_generation: row.execution_generation }),
    event_type: row.event_type,
    payload: parseJson(row.payload_json, "payload"),
    searchable_text: row.searchable_text,
    created_at: row.created_at,
    semantic_dedupe_key: row.semantic_dedupe_key,
    session_effect: row.session_effect_json === null
      ? null
      : parseJson(row.session_effect_json, "session_effect") as EventOutboxRecord["session_effect"],
    payload_hash: row.payload_hash,
  };
  const { payload_hash: payloadHash, ...unsigned } = record;
  if (computeEventOutboxPayloadHash(unsigned) !== payloadHash) {
    throw new Error(`event outbox payload hash mismatch at source_seq ${record.source_seq}`);
  }
  return record;
}

export function buildRunnerEventBatch(
  streamId: string,
  events: [EventOutboxRecord, ...EventOutboxRecord[]],
): EventOutboxBatch {
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: streamId,
    first_seq: events[0].source_seq,
    events,
  };
}

export function assertRunnerEventFits(record: EventOutboxRecord): void {
  if (
    Buffer.byteLength(JSON.stringify(buildRunnerEventBatch(record.stream_id, [record])), "utf8")
    > EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES
  ) {
    throw new Error("event payload exceeds 2 MiB ingress single-event contract");
  }
}

export function validateRunnerBootstrapInput(input: RunnerBootstrapInput): void {
  if (!input.session_id) throw new Error("runner bootstrap session_id required");
  if (!Number.isFinite(Date.parse(input.created_at))) {
    throw new Error("runner bootstrap created_at invalid");
  }
  validateRunnerResumeMaterial(input.resume);
  stringifyRunnerJson(input.resume, "resume material");
}

export function validateRunnerAppendInput(input: EventOutboxAppendInput): void {
  if (!input.session_id || !input.event_type) {
    throw new Error("event outbox session and type required");
  }
  if (input.event_type === RUNNER_BOOTSTRAP_EVENT_TYPE) {
    throw new Error("runner_bootstrap is reserved for the first durable record");
  }
  if (!Number.isFinite(Date.parse(input.created_at))) {
    throw new Error("event outbox created_at invalid");
  }
  stringifyRunnerJson(input.payload, "payload");
  if (input.session_effect !== null) {
    stringifyRunnerJson(input.session_effect, "session_effect");
  }
}

export function sameRunnerBootstrapInput(
  record: RunnerBootstrapRecord,
  input: RunnerBootstrapInput,
): boolean {
  return record.session_id === input.session_id
    && record.created_at === input.created_at
    && isDeepStrictEqual(record.payload, input.resume);
}

export function stringifyRunnerJson(value: unknown, field: string): string {
  assertRunnerJsonValue(value, `runner event outbox ${field}`);
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("undefined");
    return serialized;
  } catch (error) {
    throw new Error(`runner event outbox ${field} must be JSON serializable`, { cause: error });
  }
}

function validateRunnerResumeMaterial(value: unknown): asserts value is RunnerResumeMaterial {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new Error("runner resume material schema_version must be 1");
  }
  if (
    value.backend_session_id !== null
    && (typeof value.backend_session_id !== "string" || !value.backend_session_id)
  ) {
    throw new Error("runner resume material backend_session_id must be non-empty or null");
  }
  if (
    typeof value.cwd !== "string" || !value.cwd
    || typeof value.code_sha !== "string" || !value.code_sha
    || typeof value.snapshot_path !== "string" || !value.snapshot_path
  ) {
    throw new Error("runner resume material cwd, code_sha, and snapshot_path required");
  }
  for (const [name, item] of [
    ["codex_home", value.codex_home],
    ["rollout_root", value.rollout_root],
  ] as const) {
    if (item !== null && (typeof item !== "string" || !item)) {
      throw new Error(`runner resume material ${name} must be non-empty or null`);
    }
  }
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`runner event outbox ${field} JSON is invalid`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
