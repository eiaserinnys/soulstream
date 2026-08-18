import { describe, expect, it } from "vitest";

import {
  DELIVERY_AGGREGATE_STATES,
  DELIVERY_ATTEMPT_OUTCOMES,
} from "../../src/task/delivery_contract.js";

describe("delivery convergence contract", () => {
  it("separates attempt outcomes from aggregate delivery states", () => {
    expect(DELIVERY_ATTEMPT_OUTCOMES).toEqual([
      "accepted",
      "retryable",
      "rejected",
    ]);
    expect(DELIVERY_AGGREGATE_STATES).toEqual([
      "pending",
      "delivered",
      "consumed",
      "dead_letter",
    ]);
  });
});
