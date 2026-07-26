import { hashDeliveryPayload } from "./delivery_identity.js";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { CallerInfo } from "./task_models.js";

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

export interface CanonicalDeliveryMessage {
  text: string;
  user: string;
  attachmentPaths?: string[];
  context?: ContextItem[];
  callerInfo?: CallerInfo;
  followupTaskIds?: string[];
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

/** Reads the exact message fields persisted by the canonical terminal producer. */
export function readCanonicalDeliveryPayload(
  payload: Record<string, unknown>,
): CanonicalDeliveryMessage {
  return {
    text: requiredString(payload.text, "text"),
    user: requiredString(payload.user, "user"),
    attachmentPaths: stringArray(payload.attachment_paths),
    context: contextItems(payload.context),
    callerInfo: callerInfo(payload.caller_info),
    followupTaskIds: stringArray(payload.followup_task_ids),
  };
}

function arrayOrNull(
  value: ReadonlyArray<string> | null | undefined,
): string[] | null {
  return value === undefined || value === null ? null : [...value];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Stored delivery payload is missing ${field}`);
  }
  return value;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return values.length > 0 ? values : undefined;
}

function contextItems(value: unknown): ContextItem[] | undefined {
  return Array.isArray(value) ? value as ContextItem[] : undefined;
}

function callerInfo(value: unknown): CallerInfo | undefined {
  return value && typeof value === "object"
    ? value as CallerInfo
    : undefined;
}
