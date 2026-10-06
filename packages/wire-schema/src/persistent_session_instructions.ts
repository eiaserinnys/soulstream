/** Shared storage and command/API contract for session-scoped persistent instructions. */

export const PERSISTENT_INSTRUCTIONS_METADATA_TYPE = "persistent_instructions";

export type PersistentInstructionOrigin = "extracted" | "agent" | "user";
export type PersistentInstructionStatus = "active" | "removed";

export interface PersistentInstruction {
  id: string;
  text: string;
  source_turns: string[];
  source_event_ids: number[];
  created_at: string;
  updated_at: string;
  status: PersistentInstructionStatus;
  origin: PersistentInstructionOrigin;
}

export type PersistentInstructionOp =
  | { op: "add"; text: string; source_turns?: string[]; source_event_ids?: number[] }
  | { op: "update"; id: string; text?: string; status?: PersistentInstructionStatus }
  | { op: "touch"; id: string; source_turns: string[]; source_event_ids: number[] };

export interface PersistentInstructionsApplyPayload {
  session_id: string;
  origin: PersistentInstructionOrigin;
  ops: PersistentInstructionOp[];
  /** Jev `input_id` whose user turn produced this batch. */
  anchor?: string;
}

export type PersistentInstructionParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

const INSTRUCTION_KEYS = [
  "id",
  "text",
  "source_turns",
  "source_event_ids",
  "created_at",
  "updated_at",
  "status",
  "origin",
] as const;

export function parsePersistentInstruction(
  input: unknown,
): PersistentInstructionParseResult<PersistentInstruction> {
  if (!isRecord(input)) return invalid("instruction must be a JSON object");
  const unknownKey = firstUnknownKey(input, INSTRUCTION_KEYS);
  if (unknownKey) return invalid(`instruction.${unknownKey} is not supported`);

  const id = nonEmptyString(input.id, "instruction.id");
  if (!id.ok) return id;
  const text = nonEmptyString(input.text, "instruction.text");
  if (!text.ok) return text;
  const sourceTurns = parseTurns(input.source_turns, "instruction.source_turns");
  if (!sourceTurns.ok) return sourceTurns;
  const sourceEventIds = parseEventIds(input.source_event_ids, "instruction.source_event_ids");
  if (!sourceEventIds.ok) return sourceEventIds;
  const createdAt = nonEmptyString(input.created_at, "instruction.created_at");
  if (!createdAt.ok) return createdAt;
  const updatedAt = nonEmptyString(input.updated_at, "instruction.updated_at");
  if (!updatedAt.ok) return updatedAt;
  if (!isInstructionStatus(input.status)) return invalid("instruction.status is invalid");
  if (!isInstructionOrigin(input.origin)) return invalid("instruction.origin is invalid");

  return {
    ok: true,
    value: {
      id: id.value,
      text: text.value,
      source_turns: sourceTurns.value,
      source_event_ids: sourceEventIds.value,
      created_at: createdAt.value,
      updated_at: updatedAt.value,
      status: input.status,
      origin: input.origin,
    },
  };
}

export function parsePersistentInstructionsApplyPayload(
  input: unknown,
): PersistentInstructionParseResult<PersistentInstructionsApplyPayload> {
  if (!isRecord(input)) return invalid("payload must be a JSON object");
  const unknownKey = firstUnknownKey(input, ["session_id", "origin", "ops", "anchor"]);
  if (unknownKey) return invalid(`payload.${unknownKey} is not supported`);

  const sessionId = nonEmptyString(input.session_id, "payload.session_id");
  if (!sessionId.ok) return sessionId;
  if (!isInstructionOrigin(input.origin)) return invalid("payload.origin is invalid");
  if (!Array.isArray(input.ops)) return invalid("payload.ops must be an array");
  if (input.anchor !== undefined && (typeof input.anchor !== "string" || input.anchor.trim().length === 0)) {
    return invalid("payload.anchor must be a non-empty string when provided");
  }

  const ops: PersistentInstructionOp[] = [];
  for (let index = 0; index < input.ops.length; index++) {
    const parsed = parseInstructionOp(input.ops[index], `payload.ops[${index}]`);
    if (!parsed.ok) return parsed;
    ops.push(parsed.value);
  }
  return {
    ok: true,
    value: {
      session_id: sessionId.value,
      origin: input.origin,
      ops,
      ...(input.anchor === undefined ? {} : { anchor: input.anchor.trim() }),
    },
  };
}

export function readPersistentInstructions(metadata: unknown): PersistentInstruction[] {
  if (!Array.isArray(metadata)) return [];
  let stored: unknown;
  for (let index = metadata.length - 1; index >= 0; index--) {
    const entry = metadata[index];
    if (isRecord(entry) && entry.type === PERSISTENT_INSTRUCTIONS_METADATA_TYPE) {
      stored = entry.value;
      break;
    }
  }
  if (!Array.isArray(stored)) return [];
  const parsed = stored.map(parsePersistentInstruction);
  return parsed.every((result) => result.ok)
    ? parsed.map((result) => result.value)
    : [];
}

export function buildPersistentInstructionsMetadataEntry(
  instructions: PersistentInstruction[],
): Record<string, unknown> {
  return { type: PERSISTENT_INSTRUCTIONS_METADATA_TYPE, value: instructions };
}

function parseInstructionOp(
  input: unknown,
  label: string,
): PersistentInstructionParseResult<PersistentInstructionOp> {
  if (!isRecord(input)) return invalid(`${label} must be a JSON object`);
  if (input.op === "add") {
    const unknownKey = firstUnknownKey(input, ["op", "text", "source_turns", "source_event_ids"]);
    if (unknownKey) return invalid(`${label}.${unknownKey} is not supported`);
    const text = nonEmptyString(input.text, `${label}.text`);
    if (!text.ok) return text;
    const turns = input.source_turns === undefined
      ? { ok: true as const, value: [] as string[] }
      : parseTurns(input.source_turns, `${label}.source_turns`);
    if (!turns.ok) return turns;
    const eventIds = input.source_event_ids === undefined
      ? { ok: true as const, value: [] as number[] }
      : parseEventIds(input.source_event_ids, `${label}.source_event_ids`);
    if (!eventIds.ok) return eventIds;
    return { ok: true, value: { op: "add", text: text.value, source_turns: turns.value, source_event_ids: eventIds.value } };
  }
  if (input.op === "update") {
    const unknownKey = firstUnknownKey(input, ["op", "id", "text", "status"]);
    if (unknownKey) return invalid(`${label}.${unknownKey} is not supported`);
    const id = nonEmptyString(input.id, `${label}.id`);
    if (!id.ok) return id;
    if (input.text === undefined && input.status === undefined) return invalid(`${label} requires text or status`);
    let text: string | undefined;
    if (input.text !== undefined) {
      const parsed = nonEmptyString(input.text, `${label}.text`);
      if (!parsed.ok) return parsed;
      text = parsed.value;
    }
    if (input.status !== undefined && !isInstructionStatus(input.status)) return invalid(`${label}.status is invalid`);
    return {
      ok: true,
      value: {
        op: "update",
        id: id.value,
        ...(text === undefined ? {} : { text }),
        ...(input.status === undefined ? {} : { status: input.status }),
      },
    };
  }
  if (input.op === "touch") {
    const unknownKey = firstUnknownKey(input, ["op", "id", "source_turns", "source_event_ids"]);
    if (unknownKey) return invalid(`${label}.${unknownKey} is not supported`);
    const id = nonEmptyString(input.id, `${label}.id`);
    if (!id.ok) return id;
    const turns = parseTurns(input.source_turns, `${label}.source_turns`);
    if (!turns.ok) return turns;
    const eventIds = parseEventIds(input.source_event_ids, `${label}.source_event_ids`);
    if (!eventIds.ok) return eventIds;
    return { ok: true, value: { op: "touch", id: id.value, source_turns: turns.value, source_event_ids: eventIds.value } };
  }
  return invalid(`${label}.op is invalid`);
}

function parseTurns(value: unknown, label: string): PersistentInstructionParseResult<string[]> {
  if (!Array.isArray(value)) return invalid(`${label} must be an array`);
  if (value.some((turn) => typeof turn !== "string" || !/^T\d+$/.test(turn))) {
    return invalid(`${label} must contain turn ids such as T195`);
  }
  return { ok: true, value: [...value] as string[] };
}

function parseEventIds(value: unknown, label: string): PersistentInstructionParseResult<number[]> {
  if (!Array.isArray(value)) return invalid(`${label} must be an array`);
  if (value.some((eventId) => typeof eventId !== "number" || !Number.isSafeInteger(eventId) || eventId < 0)) {
    return invalid(`${label} must contain non-negative integer event ids`);
  }
  return { ok: true, value: [...value] as number[] };
}

function nonEmptyString(value: unknown, label: string): PersistentInstructionParseResult<string> {
  if (typeof value !== "string" || value.trim().length === 0) return invalid(`${label} must be a non-empty string`);
  return { ok: true, value: value.trim() };
}

function firstUnknownKey(input: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(input).find((key) => !allowed.includes(key));
}

function isInstructionOrigin(value: unknown): value is PersistentInstructionOrigin {
  return value === "extracted" || value === "agent" || value === "user";
}

function isInstructionStatus(value: unknown): value is PersistentInstructionStatus {
  return value === "active" || value === "removed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): PersistentInstructionParseResult<never> {
  return { ok: false, message };
}
