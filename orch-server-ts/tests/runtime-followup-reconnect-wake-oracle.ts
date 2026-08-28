import {
  ACTIVE_TURN_DELIVERY_IDS,
  ALL_RUNTIME_FOLLOWUP_DELIVERY_IDS,
  RECONNECT_PENDING_DELIVERY_IDS,
} from "./runtime-followup-reconnect-wake-fixture.js";

export const RUNTIME_FOLLOWUP_WAKE_MUTATIONS = [
  "reconnect_claim_excludes_runtime_followup",
  "terminal_consumes_current_turn_only",
  "post_close_discard_send_error",
] as const;

export type RuntimeFollowupWakeMutation =
  (typeof RUNTIME_FOLLOWUP_WAKE_MUTATIONS)[number];

export interface DeliveryPhaseCounts {
  claim: number;
  dispatch: number;
  receipt: number;
  consume: number;
  stale: number;
}

export interface RuntimeFollowupWakeObservation {
  counts: Record<string, DeliveryPhaseCounts>;
  pendingIds: string[];
  trace: string[];
  parentStatus: string;
  foregroundTurns: number;
  generations: number;
  duplicateDeliveries: number;
  duplicateAssistantTurns: number;
  followupQueueErrors: number;
  discardInterventionErrors: number;
  runnerSocketSendErrors: number;
  earlyNewTurns: number;
  earlyCompletedTransitions: number;
}

export function runtimeFollowupWakeViolations(
  observation: RuntimeFollowupWakeObservation,
): string[] {
  const violations: string[] = [];
  const reconnectCounts = RECONNECT_PENDING_DELIVERY_IDS.map(
    (deliveryId) => observation.counts[deliveryId],
  );
  if (reconnectCounts.some((counts) =>
    counts === undefined
    || counts.claim !== 1
    || counts.dispatch !== 1
    || counts.receipt !== 1
    || counts.stale !== 0
  )) {
    violations.push("reconnect_claim_excludes_runtime_followup");
  }
  const activeConsumedExactlyOnce = ACTIVE_TURN_DELIVERY_IDS.every(
    (deliveryId) => observation.counts[deliveryId]?.consume === 1,
  );
  const reconnectConsumedExactlyOnce = RECONNECT_PENDING_DELIVERY_IDS.every(
    (deliveryId) => observation.counts[deliveryId]?.consume === 1,
  );
  if (activeConsumedExactlyOnce && !reconnectConsumedExactlyOnce) {
    violations.push("terminal_consumes_current_turn_only");
  }
  if (
    observation.followupQueueErrors !== 0
    || observation.discardInterventionErrors !== 0
    || observation.runnerSocketSendErrors !== 0
  ) {
    violations.push("post_close_discard_send_error");
  }
  return violations;
}

export function runtimeFollowupMatrixViolations(
  observation: RuntimeFollowupWakeObservation,
): string[] {
  const violations = runtimeFollowupWakeViolations(observation);
  if (observation.parentStatus !== "completed") {
    violations.push("parent_terminal_state_lost");
  }
  if (observation.foregroundTurns !== 1 || observation.generations > 1) {
    violations.push("foreground_generation_not_coalesced");
  }
  if (
    observation.duplicateDeliveries !== 0
    || observation.duplicateAssistantTurns !== 0
  ) {
    violations.push("terminal_reconnect_duplicate_turn");
  }
  if (ALL_RUNTIME_FOLLOWUP_DELIVERY_IDS.some(
    (deliveryId) => observation.counts[deliveryId]?.consume !== 1,
  ) && !violations.includes("terminal_consumes_current_turn_only")) {
    violations.push("runtime_followup_consume_not_exactly_once");
  }
  return violations;
}

export function applyRuntimeFollowupWakeMutation(
  input: RuntimeFollowupWakeObservation,
  mutation: RuntimeFollowupWakeMutation,
): RuntimeFollowupWakeObservation {
  const observation = structuredClone(input);
  if (mutation === "reconnect_claim_excludes_runtime_followup") {
    for (const deliveryId of RECONNECT_PENDING_DELIVERY_IDS) {
      observation.counts[deliveryId]!.claim = 0;
      observation.counts[deliveryId]!.dispatch = 0;
      observation.counts[deliveryId]!.receipt = 0;
    }
  } else if (mutation === "terminal_consumes_current_turn_only") {
    for (const deliveryId of RECONNECT_PENDING_DELIVERY_IDS) {
      observation.counts[deliveryId]!.consume = 0;
    }
  } else {
    observation.followupQueueErrors = 1;
    observation.discardInterventionErrors = 1;
    observation.runnerSocketSendErrors = 1;
  }
  return observation;
}

export function noTransportControlViolations(
  observation: RuntimeFollowupWakeObservation,
): string[] {
  const pending = new Set(observation.pendingIds);
  const safe = RECONNECT_PENDING_DELIVERY_IDS.every((deliveryId) => {
    const counts = observation.counts[deliveryId];
    return pending.has(deliveryId)
      && counts?.dispatch === 0
      && counts.receipt === 0
      && counts.consume === 0;
  });
  return safe ? [] : ["missing_transport_did_not_preserve_pending"];
}

export function activeGenerationControlViolations(
  observation: RuntimeFollowupWakeObservation,
): string[] {
  return observation.earlyNewTurns === 0
    && observation.earlyCompletedTransitions === 0
    ? []
    : ["active_generation_advanced_before_terminal_barrier"];
}
