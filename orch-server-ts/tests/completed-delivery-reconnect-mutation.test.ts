import { describe, expect, it } from "vitest";

import { COMPLETED_DELIVERY_RECONNECT_MATRIX } from
  "./completed-delivery-reconnect-fixture.js";
import { observeCompletedDeliveryReconnect } from
  "./completed-delivery-reconnect-harness.js";
import {
  applyCompletedDeliveryReconnectMutation,
  COMPLETED_DELIVERY_RECONNECT_MUTATIONS,
  completedDeliveryReconnectViolations,
} from "./completed-delivery-reconnect-oracle.js";

describe("completed-session reconnect delivery mutation oracle", () => {
  it("names completed-target exclusion, reconnect-wake omission, and double-consume", async () => {
    const scenario = COMPLETED_DELIVERY_RECONNECT_MATRIX.find(
      (candidate) => candidate.label === "completed-two-input-coalesce",
    );
    if (!scenario) throw new Error("two-input reconnect scenario is unavailable");
    const witness = await observeCompletedDeliveryReconnect(
      scenario,
      "counterfactual_wake",
    );
    expect(completedDeliveryReconnectViolations(witness)).toEqual([]);

    for (const mutation of COMPLETED_DELIVERY_RECONNECT_MUTATIONS) {
      const violations = completedDeliveryReconnectViolations(
        applyCompletedDeliveryReconnectMutation(witness, mutation),
      );
      process.stdout.write(
        `COMPLETED_DELIVERY_RECONNECT_MUTATION ${mutation} ${JSON.stringify(violations)}\n`,
      );
      expect(violations).toEqual([mutation]);
    }
  });
});
