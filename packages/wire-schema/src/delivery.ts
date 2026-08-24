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
