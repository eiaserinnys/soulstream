import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { TaskDeliveryConsumption } from "../../src/task/task_delivery_consumption.js";
import {
  TaskDeliveryTurnReceipt,
  recordDeliverySessionEventEvidence,
} from "../../src/task/task_delivery_turn_receipt.js";
import { publishInterventionSent } from "../../src/task/task_intervention_events.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

function makeTask(queue: InterventionMessage[] = []): Task {
  return {
    agentSessionId: "session-evidence",
    prompt: "turn",
    status: "running",
    createdAt: new Date("2026-11-18T00:00:00.000Z"),
    lastEventId: 51,
    lastReadEventId: 0,
    interventionQueue: queue,
  };
}

function makeBroadcaster(): SessionBroadcaster {
  return { emitEventEnvelope: vi.fn().mockResolvedValue(undefined) } as unknown as
    SessionBroadcaster;
}

function makeRecorder() {
  return {
    recordConsumed: vi.fn().mockResolvedValue(undefined),
    recordTurnStarted: vi.fn().mockResolvedValue(undefined),
    discardIfConsumed: vi.fn().mockResolvedValue(false),
    recordConsumptionFailure: vi.fn().mockResolvedValue(undefined),
    recordAdmissionFailure: vi.fn().mockResolvedValue(undefined),
    recordRuntimeFollowupRelationConsumed: vi.fn().mockResolvedValue(true),
  };
}

function makeReceipt(task: Task, interventions: InterventionMessage[]) {
  const recorder = makeRecorder();
  const consumption = new TaskDeliveryConsumption(
    recorder,
    { warn: vi.fn() } as unknown as Parameters<typeof TaskDeliveryConsumption>[1],
  );
  void task;
  return {
    recorder,
    receipt: new TaskDeliveryTurnReceipt(consumption, interventions),
  };
}

/** Persists the delivery body as intervention_sent, the way publishAcceptance does. */
async function persistAcceptance(
  task: Task,
  message: InterventionMessage,
  options: { fail?: boolean } = {},
): Promise<void> {
  const persistenceDouble = makeEventPersistenceTestDouble();
  const persistence = options.fail
    ? {
        ...persistenceDouble.persistence,
        enqueueEvent: vi.fn(async () => {
          throw new Error("event outbox unavailable");
        }),
      }
    : persistenceDouble.persistence;
  await publishInterventionSent(task, message, {
    broadcaster: makeBroadcaster(),
    logger: silentLogger,
    persistence,
  });
}

function delivery(intent: InterventionMessage["deliveryIntent"]): InterventionMessage {
  return {
    text: "배달 본문",
    user: "agent",
    deliveryIntent: intent,
    deliveryId: "88888888-8888-4888-8888-888888888888",
  };
}

describe("settle uses the persisted session event as consumption evidence", () => {
  it.each([
    { label: "human_live_steer", intent: "human_live_steer" as const },
    { label: "durable_next_turn", intent: "durable_next_turn" as const },
  ])(
    "closes $label as consumed when the body reached the session but no receipt was observed",
    async ({ intent }) => {
      const message = delivery(intent);
      const task = makeTask();
      const { receipt, recorder } = makeReceipt(task, [message]);
      // Operational order: the body is persisted as a session event first,
      // then the turn ends without the receipt ever recording the delivery.
      await persistAcceptance(task, message);

      await receipt.settleEndedTurn(task);

      expect(recorder.recordAdmissionFailure).not.toHaveBeenCalled();
      expect(recorder.recordConsumed).toHaveBeenCalledWith(
        message,
        task,
        `session-event:${buildDeliveryInputUuid(message.deliveryId as string)}`,
      );
    },
  );

  it("treats a delivery that entered the turn input as session-recorded", async () => {
    const message = delivery("durable_next_turn");
    const task = makeTask();
    const { receipt, recorder } = makeReceipt(task, [message]);
    // The executor marks the turn input batch once its input event is durable.
    recordDeliverySessionEventEvidence(task, message.deliveryId);

    await receipt.settleEndedTurn(task);

    expect(recorder.recordAdmissionFailure).not.toHaveBeenCalled();
    expect(recorder.recordConsumed).toHaveBeenCalledOnce();
  });

  it("keeps the admission failure when neither evidence nor a queue entry exists", async () => {
    const message = delivery("human_live_steer");
    const task = makeTask();
    const { receipt, recorder } = makeReceipt(task, [message]);

    await receipt.settleEndedTurn(task);

    expect(recorder.recordConsumed).not.toHaveBeenCalled();
    expect(recorder.recordAdmissionFailure).toHaveBeenCalledWith(
      message,
      "delivery turn ended without a consumption receipt",
    );
  });

  it("does not count a failed event publication as evidence", async () => {
    const message = delivery("human_live_steer");
    const task = makeTask();
    const { receipt, recorder } = makeReceipt(task, [message]);

    await expect(persistAcceptance(task, message, { fail: true })).rejects.toThrow();
    await receipt.settleEndedTurn(task);

    expect(task.sessionEventDeliveryEvidence?.has(message.deliveryId as string) ?? false)
      .toBe(false);
    expect(recorder.recordConsumed).not.toHaveBeenCalled();
    expect(recorder.recordAdmissionFailure).toHaveBeenCalledOnce();
  });

  it("leaves a delivery queued for the next turn alone even with evidence", async () => {
    const message = delivery("durable_next_turn");
    const task = makeTask([message]);
    const { receipt, recorder } = makeReceipt(task, [message]);
    await persistAcceptance(task, message);

    await receipt.settleEndedTurn(task);

    expect(recorder.recordConsumed).not.toHaveBeenCalled();
    expect(recorder.recordAdmissionFailure).not.toHaveBeenCalled();
  });
});
