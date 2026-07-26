import { hashDeliveryPayload } from "./delivery_identity.js";

export interface CanonicalDeliveryPayloadInput {
  text: string;
  user: string;
  source: string;
  completionId: string;
  relationKey: string;
  attachmentPaths?: ReadonlyArray<string> | null;
  context?: unknown;
  callerInfo?: unknown;
  followupTaskIds?: ReadonlyArray<string> | null;
}

export interface CanonicalDeliveryPayload {
  payload: Record<string, unknown>;
  payloadHash: string;
}

/**
 * One canonical payload identity for durable registration, live dispatch, and recovery.
 *
 * Null placeholders are intentional: a delivery reconstructed from JSONB must hash
 * identically to the original in-memory intervention.
 */
export function buildCanonicalDeliveryPayload(
  input: CanonicalDeliveryPayloadInput,
): CanonicalDeliveryPayload {
  const payload: Record<string, unknown> = {
    text: input.text,
    user: input.user,
    attachment_paths: arrayOrNull(input.attachmentPaths),
    context: input.context ?? null,
    caller_info: input.callerInfo ?? null,
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

function arrayOrNull(
  value: ReadonlyArray<string> | null | undefined,
): string[] | null {
  return value === undefined || value === null ? null : [...value];
}
