export const DELIVERY_INTENTS = [
  "human_live_steer",
  "durable_next_turn",
  "completion_notification",
  "runtime_followup",
] as const;

export type DeliveryIntent = (typeof DELIVERY_INTENTS)[number];

export const DELIVERY_STATES = [
  "pending",
  "claimed",
  "queued",
  "delivered",
  "consumed",
  "uncertain",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

/**
 * Optional additive metadata carried across every intervention boundary.
 *
 * Missing fields deliberately preserve the legacy intervention path while the
 * persistent runtime feature gate is disabled.
 */
export interface DeliveryMetadata {
  deliveryId?: string;
  deliveryIntent?: DeliveryIntent;
  source?: string;
  completionId?: string;
  relationKey?: string;
  producerTerminalRevision?: string;
  parentDeliveryId?: string;
  callerTurnId?: string;
  createdAt?: string;
}

export function isDeliveryIntent(value: unknown): value is DeliveryIntent {
  return (
    typeof value === "string" &&
    DELIVERY_INTENTS.includes(value as DeliveryIntent)
  );
}
