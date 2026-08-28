import { describe, expect, it } from "vitest";

import {
  COMPLETED_DELIVERY_RECONNECT_MATRIX,
} from "./completed-delivery-reconnect-fixture.js";
import { observeCompletedDeliveryReconnect } from
  "./completed-delivery-reconnect-harness.js";
import { completedDeliveryReconnectViolations } from
  "./completed-delivery-reconnect-oracle.js";

describe("completed-session live-steer reconnect delivery strict RED", () => {
  it.each(COMPLETED_DELIVERY_RECONNECT_MATRIX)(
    "$label delivers every admitted input through one foreground generation",
    async (scenario) => {
      const observation = await observeCompletedDeliveryReconnect(scenario);
      const violations = completedDeliveryReconnectViolations(observation);
      process.stdout.write(
        `COMPLETED_DELIVERY_RECONNECT_RED ${scenario.label} `
          + `${JSON.stringify({ observation, violations })}\n`,
      );
      expect(violations).toEqual([]);
    },
  );
});
