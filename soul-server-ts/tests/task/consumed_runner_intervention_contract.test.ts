import { describe, expect, it } from "vitest";

import {
  discardConsumedRunnerIntervention,
  matchesConsumedDelivery,
} from "../../src/task/consumed_runner_intervention.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";

const DELIVERY_ID = "51515151-5151-4151-8151-515151515151";
const RELATION_KEY = "claude_runtime:caller:child:task@1";
const COMPLETION_ID = "completion:consumed-runner-contract";

function message(): InterventionMessage {
  return {
    text: "runtime follow-up",
    user: "system",
    source: "claude_runtime_task_followup",
    deliveryId: DELIVERY_ID,
    deliveryIntent: "runtime_followup",
    completionId: COMPLETION_ID,
    relationKey: RELATION_KEY,
  };
}

function runnerTask(interventionQueue: InterventionMessage[]): Task {
  return {
    agentSessionId: "caller",
    prompt: "foreground turn",
    status: "running",
    profileId: "roselin",
    createdAt: new Date("2026-08-28T10:00:00.000Z"),
    interventionQueue,
    runner: {
      engine: {} as never,
      dispatcher: {} as never,
      eventPersistence: "runner",
    },
  };
}

describe("consumed runner intervention discard contract", () => {
  it("does nothing when no local queue item matches the consumed delivery", async () => {
    const task = runnerTask([]);

    await expect(
      discardConsumedRunnerIntervention(task, DELIVERY_ID),
    ).resolves.toBeUndefined();
    expect(task.interventionQueue).toEqual([]);
  });

  it("removes exactly one queued item by its delivery id", async () => {
    const task = runnerTask([message()]);

    await discardConsumedRunnerIntervention(task, DELIVERY_ID);

    expect(task.interventionQueue).toEqual([]);
  });

  it("fails closed on consumed delivery identity mismatch", () => {
    expect(() => matchesConsumedDelivery({
      delivery_id: DELIVERY_ID,
      relation_key: `${RELATION_KEY}:other`,
      completion_id: COMPLETION_ID,
      aggregate_state: "consumed",
    }, message())).toThrow(`Consumed delivery identity mismatch: ${DELIVERY_ID}`);
  });
});
