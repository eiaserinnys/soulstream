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
  supervisorRole?: string;
  supervisorEpoch?: number;
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

/**
 * Direct-target protection may be delegated to the ledger only when the
 * command carries the complete identity needed for the supervisor-epoch CAS.
 * This check is deliberately synchronous: no lookup/claim TOCTOU is introduced
 * before the ledger transaction owns target validation.
 */
export function hasCompleteSupervisorLedgerIdentity(
  metadata: DeliveryMetadata,
): boolean {
  return (
    isLedgerControlledDeliveryIntent(metadata.deliveryIntent) &&
    isNonEmptyString(metadata.deliveryId) &&
    isNonEmptyString(metadata.completionId) &&
    isNonEmptyString(metadata.relationKey) &&
    isNonEmptyString(metadata.supervisorRole) &&
    Number.isSafeInteger(metadata.supervisorEpoch) &&
    (metadata.supervisorEpoch ?? -1) >= 0
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
