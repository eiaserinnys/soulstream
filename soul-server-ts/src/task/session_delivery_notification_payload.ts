import type { SessionDeliveryRow } from "../db/session_db_types.js";

export function isNotificationDeliveryIntent(
  intent: SessionDeliveryRow["intent"],
): intent is "completion_notification" | "runtime_followup" {
  return intent === "completion_notification" || intent === "runtime_followup";
}

export function buildNotificationOutboxPayload(
  row: SessionDeliveryRow,
  disposition: "queued" | "auto_resume",
): Record<string, unknown> {
  return {
    text: row.payload.text,
    user: row.payload.user,
    caller_info: row.payload.caller_info ?? null,
    source: row.source,
    delivery_id: row.delivery_id,
    delivery_intent: row.intent,
    completion_id: row.completion_id,
    relation_key: row.relation_key,
    followup_key: row.payload.followup_key,
    followup_attempt: row.payload.followup_attempt,
    disposition,
  };
}
