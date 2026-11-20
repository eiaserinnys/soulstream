import {
  DELIVERY_INTENTS,
  type DeliveryAggregateState,
  type DeliveryIntent,
} from "@soulstream/wire-schema/session-delivery";

export const DELIVERY_ATTEMPT_OUTCOMES = [
  "accepted",
  "retryable",
  "rejected",
] as const;
export type DeliveryAttemptOutcome = (typeof DELIVERY_ATTEMPT_OUTCOMES)[number];

export function isDeliveryLayerCombinationAllowed(input: {
  outcome: DeliveryAttemptOutcome;
  aggregateState: DeliveryAggregateState;
  hasTargetReceipt: boolean;
}): boolean {
  if (input.outcome === "accepted") {
    if (input.aggregateState === "pending") return !input.hasTargetReceipt;
    if (
      input.aggregateState === "delivered"
      || input.aggregateState === "consumed"
    ) return input.hasTargetReceipt;
    return false;
  }
  if (input.outcome === "retryable") {
    return input.aggregateState === "pending" && !input.hasTargetReceipt;
  }
  return input.aggregateState === "dead_letter" && !input.hasTargetReceipt;
}

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
  deliveryAttemptToken?: string;
}

export function isDeliveryIntent(value: unknown): value is DeliveryIntent {
  return (
    typeof value === "string" &&
    DELIVERY_INTENTS.includes(value as DeliveryIntent)
  );
}
