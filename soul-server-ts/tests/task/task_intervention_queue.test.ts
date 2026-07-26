import { describe, expect, it } from "vitest";

import { enqueueInterventionOnce } from "../../src/task/task_intervention_queue.js";
import type { Task } from "../../src/task/task_models.js";

function task(): Task {
  return {
    agentSessionId: "caller",
    prompt: "",
    status: "running",
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

describe("enqueueInterventionOnce", () => {
  it("converges a retried durable delivery on one queue position", () => {
    const target = task();
    const first = {
      text: "completion",
      user: "agent",
      deliveryId: "delivery-1",
    };

    expect(enqueueInterventionOnce(target, first)).toBe(1);
    expect(enqueueInterventionOnce(target, { ...first })).toBe(1);
    expect(target.interventionQueue).toEqual([first]);
  });

  it("retains legacy messages without delivery identity", () => {
    const target = task();

    expect(enqueueInterventionOnce(target, { text: "first", user: "human" })).toBe(1);
    expect(enqueueInterventionOnce(target, { text: "first", user: "human" })).toBe(2);
  });
});
