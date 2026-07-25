import type { DeliveryState } from "./delivery_contract.js";

export type CallerForegroundPhase = "generating" | "idle" | "terminal";
export type PendingDeliveryAction = "queue_only" | "resume_next_turn" | "suppress";

export interface DeliveryPolicyDecision {
  action: PendingDeliveryAction;
  interrupt: false;
  reason: string;
}

/**
 * Notification/follow-up delivery is relation-driven, not source-inferred.
 * Only a pending relation can queue or resume; every settled/in-flight state
 * converges on suppression for duplicate producers and cross-node retries.
 */
export function decideNotificationDelivery(
  state: DeliveryState,
  callerPhase: CallerForegroundPhase,
): DeliveryPolicyDecision {
  if (state !== "pending") {
    return {
      action: "suppress",
      interrupt: false,
      reason: `delivery_${state}`,
    };
  }
  if (callerPhase === "terminal") {
    return {
      action: "resume_next_turn",
      interrupt: false,
      reason: "terminal_unconsumed",
    };
  }
  return {
    action: "queue_only",
    interrupt: false,
    reason: callerPhase === "generating" ? "generating_never_interrupt" : "idle_queue",
  };
}
