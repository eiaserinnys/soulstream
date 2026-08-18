const NOTIFICATION_PAYLOAD_KEYS = new Set([
  "text",
  "user",
  "caller_info",
  "source",
  "delivery_id",
  "delivery_intent",
  "completion_id",
  "relation_key",
  "followup_key",
  "followup_attempt",
  "disposition",
]);

export function validateNotificationPayload(params: {
  deliveryId: string;
  disposition: "queued" | "auto_resume";
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const { payload } = params;
  for (const key of Object.keys(payload)) {
    if (!NOTIFICATION_PAYLOAD_KEYS.has(key)) {
      throw new Error(`Notification outbox payload has unexpected field ${key}`);
    }
  }
  for (const key of [
    "text",
    "user",
    "source",
    "delivery_id",
    "delivery_intent",
    "completion_id",
    "relation_key",
  ] as const) {
    if (typeof payload[key] !== "string" || payload[key].length === 0) {
      throw new Error(`Notification outbox payload is missing ${key}`);
    }
  }
  if (
    payload.delivery_intent !== "completion_notification" &&
    payload.delivery_intent !== "runtime_followup"
  ) {
    throw new Error(
      `Notification outbox payload has unsupported delivery_intent ${String(payload.delivery_intent)}`,
    );
  }
  if (
    payload.followup_key !== undefined &&
    payload.followup_key !== null &&
    (typeof payload.followup_key !== "string" || payload.followup_key.length === 0)
  ) {
    throw new Error("Notification outbox payload followup_key must be a string or null");
  }
  if (
    payload.followup_attempt !== undefined &&
    payload.followup_attempt !== null &&
    (typeof payload.followup_attempt !== "number" ||
      !Number.isInteger(payload.followup_attempt) ||
      payload.followup_attempt < 1)
  ) {
    throw new Error(
      "Notification outbox payload followup_attempt must be a positive integer or null",
    );
  }
  if (
    (payload.followup_key !== undefined && payload.followup_key !== null) !==
      (payload.followup_attempt !== undefined && payload.followup_attempt !== null)
  ) {
    throw new Error(
      "Notification outbox payload followup_key and followup_attempt must be provided together",
    );
  }
  if (payload.delivery_id !== params.deliveryId) {
    throw new Error(
      "Notification outbox payload delivery_id does not match the staged delivery",
    );
  }
  if (payload.disposition !== params.disposition) {
    throw new Error(
      "Notification outbox payload disposition does not match the staged delivery",
    );
  }
  if (
    payload.caller_info !== null &&
    (typeof payload.caller_info !== "object" || Array.isArray(payload.caller_info))
  ) {
    throw new Error("Notification outbox payload caller_info must be an object or null");
  }
  return payload;
}
