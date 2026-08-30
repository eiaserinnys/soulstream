export {
  buildCanonicalDeliveryPayload,
  type CanonicalDeliveryPayload,
  type CanonicalDeliveryPayloadInput,
} from "@soulstream/wire-schema/delivery";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { SessionDeliveryRow } from "../db/session_db_types.js";
import type { CallerInfo, InterventionMessage } from "./task_models.js";

export interface CanonicalDeliveryMessage {
  text: string;
  user: string;
  attachmentPaths?: string[];
  context?: ContextItem[];
  callerInfo?: CallerInfo;
  followupKey?: string;
  followupAttempt?: number;
  followupTaskIds?: string[];
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
    followupKey: optionalString(payload.followup_key),
    followupAttempt: optionalPositiveInteger(payload.followup_attempt),
    followupTaskIds: stringArray(payload.followup_task_ids),
  };
}

export function interventionFromCanonicalDelivery(
  row: SessionDeliveryRow,
): InterventionMessage {
  const canonical = readCanonicalDeliveryPayload(row.payload);
  return {
    text: canonical.text,
    user: canonical.user,
    callerInfo: canonical.callerInfo,
    attachmentPaths: canonical.attachmentPaths,
    context: canonical.context,
    followupKey: canonical.followupKey,
    followupAttempt: canonical.followupAttempt,
    followupTaskIds: canonical.followupTaskIds,
    source: row.source,
    deliveryId: row.delivery_id,
    deliveryIntent: row.intent,
    completionId: row.completion_id ?? undefined,
    relationKey: row.relation_key,
    producerTerminalRevision: row.producer_terminal_revision ?? undefined,
    parentDeliveryId: row.parent_delivery_id ?? undefined,
    callerTurnId: row.caller_turn_id ?? undefined,
    deliveryCreatedAt: row.created_at.toISOString(),
    deliveryLeaseOwner: row.lease_owner ?? undefined,
    storedDeliveryPayload: row.payload,
    storedDeliveryPayloadHash: row.payload_hash,
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Stored delivery payload is missing ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
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
