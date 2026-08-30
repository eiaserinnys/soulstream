import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EnginePort } from "../../src/engine/protocol.js";
import { engineEventFrame } from "../../src/runner/frame_protocol.js";
import { InProcessRunnerCommandDispatcher } from
  "../../src/runner/runner_command_dispatcher.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { TaskDeliveryConsumption } from
  "../../src/task/task_delivery_consumption.js";
import { TaskDeliveryTurnReceipt } from
  "../../src/task/task_delivery_turn_receipt.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from
  "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

describe("Lane E exact delivery handoff", () => {
  it("accepts exact D without waiting for generation G cancel and ignores its late ACK", async () => {
    const cancelAck = deferred<boolean>();
    const interrupt = vi.fn(() => cancelAck.promise);
    const persistence = makeEventPersistenceTestDouble();
    const task = {
      agentSessionId: "lane-e-exact-d",
      prompt: "foreground work",
      status: "running",
      createdAt: new Date("2026-08-30T03:23:15.000Z"),
      lastEventId: 0,
      lastReadEventId: 0,
      executionOwnership: {
        ownerKind: "runner_process",
        manifestId: "manifest-g",
        runtimeEnvIdentity: "runtime-g",
        ownershipGeneration: 4,
        registrationId: "registration-g",
        pid: 4104,
        startIdentity: "start-g",
        executionCommandId: "execution-g",
      },
      runner: {
        dispatcher: { interrupt },
      } as unknown as TaskRunnerRuntime,
    } satisfies Task;
    const message: InterventionMessage = {
      text: "canonical D",
      user: "human",
      deliveryId: "delivery-exact-d",
      deliveryLeaseOwner: "claim-g",
      deliveryIntent: "human_live_steer",
    };
    const transition = new RunningInterventionTransition({
      broadcaster: {
        emitEventEnvelope: vi.fn(),
        emitSessionUpdated: vi.fn(),
      } as unknown as SessionBroadcaster,
      logger: silentLogger,
      persistence: persistence.persistence,
    });

    await expect(transition.deliver(task, message)).resolves.toEqual({ delivered: true });
    expect(interrupt).toHaveBeenCalledWith({
      sessionId: "lane-e-exact-d",
      executionGeneration: 4,
      executionCommandId: "execution-g",
      deliveryId: "delivery-exact-d",
      deliveryClaimOwner: "claim-g",
    });
    expect(task.executionOwnership?.ownershipGeneration).toBe(4);
    expect(task.status).toBe("running");

    cancelAck.resolve(true);
    await cancelAck.promise;

    expect(task.executionOwnership?.ownershipGeneration).toBe(4);
    expect(task.status).toBe("running");
    expect(persistence.enqueueEvent).toHaveBeenCalledTimes(1);

    task.executionOwnership = {
      ...task.executionOwnership!,
      ownershipGeneration: 5,
      executionCommandId: "delivery:delivery-exact-d",
    };
    const recordConsumed = vi.fn().mockResolvedValue(undefined);
    const receipt = new TaskDeliveryTurnReceipt(
      new TaskDeliveryConsumption({
        recordConsumed,
        nextAcceptedForTarget: vi.fn(),
        acceptedDelivery: vi.fn(),
      }, silentLogger),
      [message],
    );
    await receipt.observe(task, { type: "session", session_id: "backend-g1" });
    await receipt.observe(task, {
      type: "assistant_message",
      content: "G+1 consumed canonical D",
    });
    await receipt.observe(task, { type: "complete", result: "done" });
    expect(recordConsumed).toHaveBeenCalledOnce();
    expect(recordConsumed).toHaveBeenCalledWith(
      message,
      task,
      "execution:5:delivery:delivery-exact-d:first-model-event",
    );
  });

  it("fences a late old-G cancel after G+1 becomes current", async () => {
    const interrupt = vi.fn().mockResolvedValue(true);
    const engine = {
      interrupt,
      async *executeFrames(params: { prompt: string }) {
        if (params.prompt === "generation G") {
          yield engineEventFrame({ type: "complete", result: "G ended" });
          return;
        }
        await new Promise<never>(() => undefined);
      },
    } as unknown as EnginePort;
    const dispatcher = new InProcessRunnerCommandDispatcher(engine);

    for await (const _frame of dispatcher.executeFrames({
      agentSessionId: "lane-e-exact-d",
      executionGeneration: 4,
      executionCommandId: "execution-g",
      prompt: "generation G",
    })) {
      // Draining the logical complete frame closes G before G+1 starts.
    }
    dispatcher.executeFrames({
      agentSessionId: "lane-e-exact-d",
      executionGeneration: 5,
      executionCommandId: "delivery:delivery-exact-d",
      prompt: "generation G+1",
    });

    await expect(dispatcher.interrupt({
      sessionId: "lane-e-exact-d",
      executionGeneration: 4,
      executionCommandId: "execution-g",
      deliveryId: "delivery-exact-d",
      deliveryClaimOwner: "claim-g",
    })).resolves.toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
