import { describe, expect, it } from "vitest";

import {
  dequeueIntervention,
  enqueueInterventionOnce,
  sortInterventionsByPriority,
} from "../../src/task/task_intervention_queue.js";
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
  it("reorders a legacy unsorted queue at the direct dequeue boundary", () => {
    const target = task();
    target.interventionQueue.push(
      {
        text: "stale runtime follow-up",
        user: "system",
        source: "claude_runtime_task_followup",
      },
      { text: "live user message", user: "alice", source: "browser" },
    );

    expect(dequeueIntervention(target)?.text).toBe("live user message");
    expect(dequeueIntervention(target)?.text).toBe("stale runtime follow-up");
  });

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

  it("consumes user/direct messages before notification and runtime lanes", () => {
    const target = task();

    enqueueInterventionOnce(target, {
      text: "completion first",
      user: "agent",
      deliveryIntent: "completion_notification",
    });
    enqueueInterventionOnce(target, {
      text: "runtime second",
      user: "system",
      deliveryIntent: "runtime_followup",
    });
    enqueueInterventionOnce(target, {
      text: "human third",
      user: "human",
    });
    enqueueInterventionOnce(target, {
      text: "unknown fourth",
      user: "system",
      source: "future_source",
    });

    expect(target.interventionQueue.map((message) => message.text)).toEqual([
      "human third",
      "unknown fourth",
      "completion first",
      "runtime second",
    ]);
  });

  it("treats the legacy Claude runtime source as low priority", () => {
    const sorted = sortInterventionsByPriority([
      { text: "legacy runtime", user: "system", source: "claude_runtime_task_followup" },
      { text: "direct", user: "human" },
    ]);

    expect(sorted.map((message) => message.text)).toEqual(["direct", "legacy runtime"]);
  });

  it("reports queue position from the priority order", () => {
    const target = task();
    enqueueInterventionOnce(target, {
      text: "low",
      user: "agent",
      deliveryId: "delivery-low",
      deliveryIntent: "completion_notification",
    });

    expect(enqueueInterventionOnce(target, {
      text: "high",
      user: "human",
      deliveryId: "delivery-high",
    })).toBe(1);
    expect(enqueueInterventionOnce(target, {
      text: "low",
      user: "agent",
      deliveryId: "delivery-low",
      deliveryIntent: "completion_notification",
    })).toBe(2);
  });
});
