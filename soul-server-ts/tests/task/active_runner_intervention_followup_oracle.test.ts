import { describe, expect, it } from "vitest";

import {
  activeRunnerViolations,
  applyActiveRunnerMutation,
  idealActiveRunnerObservation,
  type ActiveRunnerMutation,
} from "./active_runner_intervention_followup_oracle.js";

const HUMAN_DELIVERY_ID = "delivery-human-live-steer";
const RUNTIME_FOLLOWUP_ID = "runtime-followup-1";

describe("active runner intervention follow-up oracle", () => {
  const ideal = idealActiveRunnerObservation({
    humanDeliveryId: HUMAN_DELIVERY_ID,
    runtimeFollowupId: RUNTIME_FOLLOWUP_ID,
  });

  it("is satisfiable when every transition boundary is ideal", () => {
    expect(activeRunnerViolations(ideal)).toEqual([]);
  });

  it.each([
    [
      "drop_successor_delivery",
      [
        "human_marker_model_input_not_exactly_once",
        "human_delivery_consume_not_exactly_once",
      ],
    ],
    ["double_interrupt", ["interrupt_not_exactly_once"]],
    ["lose_next_turn", ["next_turn_not_activated", "next_turn_not_completed"]],
    [
      "promote_parent_error",
      ["parent_error", "parent_not_completed", "parent_error_aborted"],
    ],
  ] satisfies Array<[ActiveRunnerMutation, string[]]>) (
    "detects the %s mutation",
    (mutation, expectedViolations) => {
      expect(activeRunnerViolations(applyActiveRunnerMutation(ideal, mutation)))
        .toEqual(expectedViolations);
    },
  );
});
