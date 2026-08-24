export {
  buildCanonicalDeliveryPayload,
  type CanonicalDeliveryPayload,
  type CanonicalDeliveryPayloadInput,
} from "@soulstream/wire-schema/delivery";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { CallerInfo } from "./task_models.js";

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
