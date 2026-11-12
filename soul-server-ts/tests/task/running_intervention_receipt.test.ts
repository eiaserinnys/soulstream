import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import type { EnginePort } from "../../src/engine/protocol.js";
import { createInProcessTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

function makeRunningTask(intervene: ReturnType<typeof vi.fn>): Task {
  return {
    agentSessionId: "session-receipt",
    prompt: "original prompt",
    status: "running",
    profileId: "codex-default",
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    lastEventId: 1,
    lastReadEventId: 0,
    interventionQueue: [],
    runner: createInProcessTaskRunnerRuntime({
      backendId: "codex",
      workspaceDir: "/tmp/receipt",
      async *execute() {},
      async interrupt() { return true; },
      async close() {},
      intervene,
    } as unknown as EnginePort),
  };
}

function makeBroadcaster(): SessionBroadcaster {
  return { emitEventEnvelope: vi.fn().mockResolvedValue(undefined) } as unknown as
    SessionBroadcaster;
}

function makeTransition(): RunningInterventionTransition {
  return new RunningInterventionTransition({
    broadcaster: makeBroadcaster(),
    logger: silentLogger,
    persistence: makeEventPersistenceTestDouble().persistence,
  });
}

describe("running intervention receipt id", () => {
  it.each([
    {
      label: "the delivery id when the message has one",
      message: { text: "steer", user: "alice", deliveryId: "delivery-a" },
      expected: "delivery-a",
    },
    {
      label: "an id the caller already assigned",
      message: {
        text: "steer",
        user: "alice",
        deliveryId: "delivery-a",
        runnerInterventionId: "intervention-explicit",
      },
      expected: "intervention-explicit",
    },
  ])("attaches $label", async ({ message, expected }) => {
    const intervene = vi.fn().mockResolvedValue({
      status: "delivered",
      mechanism: "active_turn",
    });
    const task = makeRunningTask(intervene);
    const queued: InterventionMessage = { ...message };

    await expect(makeTransition().deliver(task, queued)).resolves
      .toEqual({ delivered: true });

    expect(intervene).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("steer"),
      runnerInterventionId: expected,
    }));
    // The queued message is not mutated; only the engine input carries the id.
    expect(queued).toEqual(message);
  });

  it("mints an id when neither a delivery id nor an intervention id exists", async () => {
    const intervene = vi.fn().mockResolvedValue({
      status: "delivered",
      mechanism: "active_turn",
    });
    const task = makeRunningTask(intervene);
    const message: InterventionMessage = { text: "steer", user: "alice" };

    await expect(makeTransition().deliver(task, message)).resolves
      .toEqual({ delivered: true });

    const input = intervene.mock.calls[0]![0] as { runnerInterventionId: string };
    expect(input.runnerInterventionId.length).toBeGreaterThan(0);
    expect(message).toEqual({ text: "steer", user: "alice" });
  });

  it("keeps the delivery input uuid separate from the receipt id", async () => {
    const intervene = vi.fn().mockResolvedValue({
      status: "delivered",
      mechanism: "active_turn",
    });
    const task = makeRunningTask(intervene);

    await makeTransition().deliver(task, {
      text: "steer",
      user: "alice",
      deliveryId: "delivery-a",
    });

    const input = intervene.mock.calls[0]![0] as {
      inputUuid?: string;
      runnerInterventionId?: string;
    };
    expect(input.runnerInterventionId).toBe("delivery-a");
    expect(input.inputUuid).toBeDefined();
    expect(input.inputUuid).not.toBe("delivery-a");
  });
});
