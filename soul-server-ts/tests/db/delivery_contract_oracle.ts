import type {
  DeliveryAggregateState,
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
