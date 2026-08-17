import { describe, expect, it } from "vitest";

import { interventionTurnOrigin } from "../../src/task/turn_origin.js";

describe("interventionTurnOrigin", () => {
  it("uses the fixed origin id fallback order", () => {
    const base = {
      text: "follow up",
      user: "system",
      source: "claude_runtime_task_followup",
      deliveryIntent: "runtime_followup" as const,
      deliveryId: "delivery-1",
      runnerInterventionId: "runner-1",
      callerTurnId: "caller-1",
    };

    expect(interventionTurnOrigin(base, "input-1").id).toBe("delivery-1");
    expect(interventionTurnOrigin({ ...base, deliveryId: undefined }, "input-1").id)
      .toBe("runner-1");
    expect(interventionTurnOrigin({
      ...base,
      deliveryId: undefined,
      runnerInterventionId: undefined,
    }, "input-1").id).toBe("caller-1");
    expect(interventionTurnOrigin({
      ...base,
      deliveryId: undefined,
      runnerInterventionId: undefined,
      callerTurnId: undefined,
    }, "input-1").id).toBe("input-1");
  });

  it("classifies unknown sources as user messages", () => {
    expect(interventionTurnOrigin({
      text: "hello",
      user: "alice",
      source: "future-client",
    })).toEqual({ kind: "user_message" });
  });
});
