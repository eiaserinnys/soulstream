import type { CompletedDeliveryReconnectScenario } from
  "./completed-delivery-reconnect-fixture.js";

export const COMPLETED_DELIVERY_RECONNECT_MUTATIONS = [
  "completed_target_exclusion",
  "reconnect_wake_omission",
  "double_consume",
] as const;

export type CompletedDeliveryReconnectMutation =
  (typeof COMPLETED_DELIVERY_RECONNECT_MUTATIONS)[number];

export interface CompletedDeliveryReconnectObservation {
  label: CompletedDeliveryReconnectScenario["label"];
  reconnect: boolean;
  targetStatus: CompletedDeliveryReconnectScenario["targetStatus"];
  deliveryIds: string[];
  expectedNewGenerations: number;
  httpStatuses: number[];
  httpOutcomes: string[];
  admittedIds: string[];
  claimEligibleIds: string[];
  reconnectSignals: number;
  reconnectWakeIds: string[];
  nodeDispatchIds: string[];
  receiptIds: string[];
  consumeIds: string[];
  deadLetterIds: string[];
  semanticInputIds: string[];
  modelInputIds: string[];
  reserveIds: string[];
  proveIds: string[];
  activateIds: string[];
  newGenerations: number;
  foregroundTurns: number;
  assistantProgressIds: string[];
  assistantResultIds: string[];
}

export function completedDeliveryReconnectViolations(
  observation: CompletedDeliveryReconnectObservation,
): string[] {
  const expected = observation.deliveryIds;
  if (!exactInventory(observation.admittedIds, expected)) {
    return ["durable_admission_not_exactly_once"];
  }
  if (
    observation.targetStatus === "completed"
    && !exactInventory(observation.claimEligibleIds, expected)
  ) {
    return ["completed_target_exclusion"];
  }
  if (
    observation.reconnect
    && (
      observation.reconnectSignals !== 1
      || !exactInventory(observation.reconnectWakeIds, expected)
    )
  ) {
    return ["reconnect_wake_omission"];
  }
  if (!exactInventory(observation.nodeDispatchIds, expected)) {
    return ["node_dispatch_not_exactly_once"];
  }
  if (!exactInventory(observation.receiptIds, expected)) {
    return ["delivery_receipt_not_exactly_once"];
  }
  if (hasDuplicate(observation.consumeIds)) {
    return ["double_consume"];
  }
  if (!exactInventory(observation.consumeIds, expected)) {
    return ["delivery_consume_not_exactly_once"];
  }
  if (observation.deadLetterIds.length !== 0) {
    return ["delivery_dead_lettered"];
  }
  if (!exactInventory(observation.semanticInputIds, expected)) {
    return ["semantic_input_loss_or_duplicate"];
  }
  if (!exactInventory(observation.modelInputIds, expected)) {
    return ["model_input_loss_or_duplicate"];
  }
  if (observation.newGenerations !== observation.expectedNewGenerations) {
    return ["generation_count_mismatch"];
  }
  if (observation.newGenerations > 1 || observation.foregroundTurns !== 1) {
    return ["foreground_turn_not_coalesced"];
  }
  if (observation.expectedNewGenerations === 1) {
    if (
      observation.reserveIds.length !== 1
      || observation.proveIds.length !== 1
      || observation.activateIds.length !== 1
    ) {
      return ["reserve_prove_activate_not_exactly_once"];
    }
  } else if (
    observation.reserveIds.length !== 0
    || observation.proveIds.length !== 0
    || observation.activateIds.length !== 0
  ) {
    return ["active_generation_was_replaced"];
  }
  if (!exactInventory(observation.assistantProgressIds, expected)) {
    return ["assistant_progress_missing"];
  }
  if (!exactInventory(observation.assistantResultIds, expected)) {
    return ["assistant_result_missing"];
  }
  if (
    observation.httpStatuses.some((status) => status !== 200)
    || observation.httpOutcomes.length !== expected.length
  ) {
    return ["http_admission_failed"];
  }
  return [];
}

export function applyCompletedDeliveryReconnectMutation(
  observation: CompletedDeliveryReconnectObservation,
  mutation: CompletedDeliveryReconnectMutation,
): CompletedDeliveryReconnectObservation {
  const mutated = structuredClone(observation);
  if (mutation === "completed_target_exclusion") {
    mutated.claimEligibleIds = [];
  } else if (mutation === "reconnect_wake_omission") {
    mutated.reconnectWakeIds = [];
  } else {
    mutated.consumeIds.push(mutated.deliveryIds[0]!);
  }
  return mutated;
}

function exactInventory(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length
    && new Set(actual).size === expected.length
    && expected.every((item) => actual.includes(item));
}

function hasDuplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}
