export const DELIVERY_INTENTS = [
  "human_live_steer",
  "durable_next_turn",
  "completion_notification",
  "runtime_followup",
] as const;

export type DeliveryIntent = (typeof DELIVERY_INTENTS)[number];
export type LedgerControlledDeliveryIntent = Exclude<
  DeliveryIntent,
  "human_live_steer"
>;

export const DELIVERY_STATES = [
  "pending",
  "claimed",
  "dispatching",
  "queued",
  "delivered",
  "consumed",
  "superseded",
  "uncertain",
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const DELIVERY_ATTEMPT_OUTCOMES = [
  "accepted",
  "retryable",
  "rejected",
] as const;
export type DeliveryAttemptOutcome = (typeof DELIVERY_ATTEMPT_OUTCOMES)[number];

export const DELIVERY_AGGREGATE_STATES = [
  "pending",
  "delivered",
  "consumed",
  "dead_letter",
] as const;
export type DeliveryAggregateState = (typeof DELIVERY_AGGREGATE_STATES)[number];

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
  deliveryLeaseOwner?: string;
}

export function isDeliveryIntent(value: unknown): value is DeliveryIntent {
  return (
    typeof value === "string" &&
    DELIVERY_INTENTS.includes(value as DeliveryIntent)
  );
}

export function isLedgerControlledDeliveryIntent(
  value: unknown,
): value is LedgerControlledDeliveryIntent {
  return (
    value === "durable_next_turn" ||
    value === "completion_notification" ||
    value === "runtime_followup"
  );
}
