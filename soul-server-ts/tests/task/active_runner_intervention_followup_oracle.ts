import type { TaskStatus } from "../../src/task/task_models.js";

export type ActiveRunnerMutation =
  | "drop_successor_delivery"
  | "double_interrupt"
  | "lose_next_turn"
  | "promote_parent_error";

export interface ActiveRunnerObservation {
  humanDeliveryId: string;
  runtimeFollowupId: string;
  activeOwnerCount: number;
  humanLiveSteerDeliveryIds: string[];
  runtimeFollowupIds: string[];
  interruptDeliveryIds: string[];
  humanModelInputDeliveryIds: string[];
  humanConsumedDeliveryIds: string[];
  nextTurnActivatedDeliveryIds: string[];
  nextTurnCompletedDeliveryIds: string[];
  parentStatus: TaskStatus;
  parentTerminationHint: string | null;
}

export function activeRunnerViolations(
  observation: ActiveRunnerObservation,
): string[] {
  const violations: string[] = [];
  const humanDelivery = [observation.humanDeliveryId];
  const runtimeFollowup = [observation.runtimeFollowupId];

  if (observation.activeOwnerCount !== 1) {
    violations.push("active_owner_not_exactly_once");
  }
  if (!sameStrings(observation.humanLiveSteerDeliveryIds, humanDelivery)) {
    violations.push("human_live_steer_not_exactly_once");
  }
  if (!sameStrings(observation.runtimeFollowupIds, runtimeFollowup)) {
    violations.push("runtime_followup_not_exactly_once");
  }
  if (!sameStrings(observation.interruptDeliveryIds, humanDelivery)) {
    violations.push("interrupt_not_exactly_once");
  }
  if (!sameStrings(observation.humanModelInputDeliveryIds, humanDelivery)) {
    violations.push("human_marker_model_input_not_exactly_once");
  }
  if (!sameStrings(observation.humanConsumedDeliveryIds, humanDelivery)) {
    violations.push("human_delivery_consume_not_exactly_once");
  }
  if (!sameStrings(observation.nextTurnActivatedDeliveryIds, humanDelivery)) {
    violations.push("next_turn_not_activated");
  }
  if (!sameStrings(observation.nextTurnCompletedDeliveryIds, humanDelivery)) {
    violations.push("next_turn_not_completed");
  }
  if (observation.parentStatus === "error") violations.push("parent_error");
  if (observation.parentStatus === "interrupted") violations.push("parent_interrupted");
  if (observation.parentStatus !== "completed") violations.push("parent_not_completed");
  if (observation.parentTerminationHint === "error_aborted") {
    violations.push("parent_error_aborted");
  }

  return violations;
}

export function idealActiveRunnerObservation(input: {
  humanDeliveryId: string;
  runtimeFollowupId: string;
}): ActiveRunnerObservation {
  return {
    ...input,
    activeOwnerCount: 1,
    humanLiveSteerDeliveryIds: [input.humanDeliveryId],
    runtimeFollowupIds: [input.runtimeFollowupId],
    interruptDeliveryIds: [input.humanDeliveryId],
    humanModelInputDeliveryIds: [input.humanDeliveryId],
    humanConsumedDeliveryIds: [input.humanDeliveryId],
    nextTurnActivatedDeliveryIds: [input.humanDeliveryId],
    nextTurnCompletedDeliveryIds: [input.humanDeliveryId],
    parentStatus: "completed",
    parentTerminationHint: null,
  };
}

export function applyActiveRunnerMutation(
  observation: ActiveRunnerObservation,
  mutation: ActiveRunnerMutation,
): ActiveRunnerObservation {
  if (mutation === "drop_successor_delivery") {
    return {
      ...observation,
      humanModelInputDeliveryIds: [],
      humanConsumedDeliveryIds: [],
    };
  }
  if (mutation === "double_interrupt") {
    return {
      ...observation,
      interruptDeliveryIds: [observation.humanDeliveryId, observation.humanDeliveryId],
    };
  }
  if (mutation === "lose_next_turn") {
    return {
      ...observation,
      nextTurnActivatedDeliveryIds: [],
      nextTurnCompletedDeliveryIds: [],
    };
  }
  return {
    ...observation,
    parentStatus: "error",
    parentTerminationHint: "error_aborted",
  };
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}
