import { createHash } from "node:crypto";

export interface CanonicalDeliveryPayloadInput {
  text: string;
  user: string;
  source: string;
  completionId: string;
  relationKey: string;
  attachmentPaths?: ReadonlyArray<string> | null;
  context?: unknown;
  callerInfo?: unknown;
  rateLimitType?: string;
  resetsAt?: string;
  followupKey?: string;
  followupAttempt?: number;
  followupTaskIds?: ReadonlyArray<string> | null;
}

export interface CanonicalDeliveryPayload {
  payload: Record<string, unknown>;
  payloadHash: string;
}

/** One immutable payload identity across admission, dispatch, and recovery. */
export function buildCanonicalDeliveryPayload(
  input: CanonicalDeliveryPayloadInput,
): CanonicalDeliveryPayload {
  const payload: Record<string, unknown> = {
    text: input.text,
    user: input.user,
    attachment_paths: arrayOrNull(input.attachmentPaths),
    context: input.context ?? null,
    caller_info: input.callerInfo ?? null,
    ...(input.rateLimitType !== undefined
      ? { rate_limit_type: input.rateLimitType }
      : {}),
    ...(input.resetsAt !== undefined ? { resets_at: input.resetsAt } : {}),
    followup_key: input.followupKey ?? null,
    followup_attempt: input.followupAttempt ?? null,
    followup_task_ids: arrayOrNull(input.followupTaskIds),
  };
  return {
    payload,
    payloadHash: hashDeliveryPayload({
      ...payload,
      source: input.source,
      completion_id: input.completionId,
      relation_key: input.relationKey,
    }),
  };
}

export function hashDeliveryPayload(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function arrayOrNull(
  value: ReadonlyArray<string> | null | undefined,
): string[] | null {
  return value === undefined || value === null ? null : [...value];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : canonicalize(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export interface DeterministicDeliveryIdentity {
  deliveryId: string;
  completionId: string;
  relationKey: string;
}

export function buildDeterministicDeliveryIdentity(params: {
  /** Routing target is deliberately not part of the immutable delivery identity. */
  targetSessionId: string;
  relationKey: string;
  intent: string;
}): DeterministicDeliveryIdentity {
  const completionId = `completion:${hashHex(params.relationKey)}`;
  const deliverySeed = [
    params.intent,
    params.relationKey,
  ].join("\u0000");
  return {
    deliveryId: uuidFromHash(hashHex(deliverySeed)),
    completionId,
    relationKey: params.relationKey,
  };
}

/**
 * A durable delivery owns one stable Claude SDK input UUID across worker
 * restarts. The UUID is deliberately derived instead of reusing delivery_id
 * verbatim because external callers may supply non-UUID delivery identities.
 */
export function buildDeliveryInputUuid(deliveryId: string): string {
  return uuidFromHash(hashHex(`claude_input\u0000${deliveryId}`));
}

function hashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uuidFromHash(hex: string): string {
  const bytes = Buffer.from(hex.slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const normalized = bytes.toString("hex");
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20, 32),
  ].join("-");
}
