import { describe, expect, it, vi } from "vitest";

import {
  discardConsumedRunnerIntervention,
  matchesConsumedDelivery,
} from "../../src/task/consumed_runner_intervention.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";

const DELIVERY_ID = "51515151-5151-4151-8151-515151515151";
const RUNNER_INTERVENTION_ID = "61616161-6161-4161-8161-616161616161";
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
    runnerInterventionId: RUNNER_INTERVENTION_ID,
  };
}

function runnerTask(
  interventionQueue: InterventionMessage[],
  discardIntervention: (interventionId: string) => Promise<void>,
): Task {
  return {
    agentSessionId: "caller",
    prompt: "foreground turn",
    status: "running",
    profileId: "roselin",
    createdAt: new Date("2026-08-28T10:00:00.000Z"),
    interventionQueue,
    runner: {
      engine: {} as never,
      dispatcher: { discardIntervention } as never,
      eventPersistence: "runner",
    },
  };
}

describe("consumed runner intervention discard contract", () => {
  it("does not guess a runner command identity when no local queue item exists", async () => {
    const discardIntervention = vi.fn(async () => undefined);
    const task = runnerTask([], discardIntervention);

    await expect(
      discardConsumedRunnerIntervention(task, DELIVERY_ID),
    ).resolves.toBeUndefined();
    expect(discardIntervention).not.toHaveBeenCalled();
  });

  it("discards one exact queued item by its stored runner intervention id", async () => {
    const discardIntervention = vi.fn(async () => undefined);
    const task = runnerTask([message()], discardIntervention);

    await discardConsumedRunnerIntervention(task, DELIVERY_ID);

    expect(discardIntervention).toHaveBeenCalledTimes(1);
    expect(discardIntervention).toHaveBeenCalledWith(RUNNER_INTERVENTION_ID);
    expect(task.interventionQueue).toEqual([]);
  });

  it("exposes a real runner discard failure", async () => {
    const discardIntervention = vi.fn(async () => {
      throw new Error("durable discard failed");
    });
    const task = runnerTask([message()], discardIntervention);

    await expect(
      discardConsumedRunnerIntervention(task, DELIVERY_ID),
    ).rejects.toThrow("durable discard failed");
    expect(discardIntervention).toHaveBeenCalledTimes(1);
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
