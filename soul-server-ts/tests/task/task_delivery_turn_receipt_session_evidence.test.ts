import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { TaskDeliveryConsumption } from "../../src/task/task_delivery_consumption.js";
import {
  TaskDeliveryTurnReceipt,
  recordDeliverySessionEventEvidence,
} from "../../src/task/task_delivery_turn_receipt.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { publishInterventionSent } from "../../src/task/task_intervention_events.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

const agent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

function makeTask(
  queue: InterventionMessage[] = [],
  overrides: Partial<Task> = {},
): Task {
  return {
    agentSessionId: "session-evidence",
    prompt: "turn",
    status: "completed",
    terminationReason: "completed_ok",
    createdAt: new Date("2026-11-18T00:00:00.000Z"),
    lastEventId: 51,
    lastReadEventId: 0,
    interventionQueue: queue,
    ...overrides,
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

function makeReceipt(interventions: InterventionMessage[]) {
  const recorder = makeRecorder();
  const consumption = new TaskDeliveryConsumption(
    recorder,
    { warn: vi.fn() } as unknown as Parameters<typeof TaskDeliveryConsumption>[1],
  );
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

function sessionEventReceiptId(message: InterventionMessage): string {
  return `session-event:${buildDeliveryInputUuid(message.deliveryId as string)}`;
}

describe("settle uses the persisted session event as consumption evidence", () => {
  it.each([
    { label: "human_live_steer", intent: "human_live_steer" as const },
    { label: "durable_next_turn", intent: "durable_next_turn" as const },
  ])(
    "closes $label as consumed when the turn ended normally without a record attempt",
    async ({ intent }) => {
      const message = delivery(intent);
      const task = makeTask();
      const { receipt, recorder } = makeReceipt([message]);
      // Operational order: the body is persisted as a session event while the
      // turn runs, and this turn never observed a receipt for the delivery.
      await persistAcceptance(task, message);

      await receipt.settleEndedTurn(task);

      expect(recorder.recordTurnStarted).toHaveBeenCalledOnce();
      expect(recorder.recordConsumed).toHaveBeenCalledWith(
        message,
        task,
        sessionEventReceiptId(message),
      );
      expect(recorder.recordAdmissionFailure).not.toHaveBeenCalled();
      expect(task.sessionEventDeliveryEvidence?.has(message.deliveryId as string) ?? false)
        .toBe(false);
    },
  );

  it("treats a delivery that entered the turn input as session-recorded", async () => {
    const message = delivery("durable_next_turn");
    const task = makeTask();
    const { receipt, recorder } = makeReceipt([message]);
    // The executor marks the turn input batch once its input event is durable.
    recordDeliverySessionEventEvidence(task, message.deliveryId);

    await receipt.settleEndedTurn(task);

    expect(recorder.recordAdmissionFailure).not.toHaveBeenCalled();
    expect(recorder.recordConsumed).toHaveBeenCalledOnce();
  });

  it("keeps the admission failure when neither evidence nor a queue entry exists", async () => {
    const message = delivery("human_live_steer");
    const task = makeTask();
    const { receipt, recorder } = makeReceipt([message]);

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
    const { receipt, recorder } = makeReceipt([message]);

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
    const { receipt, recorder } = makeReceipt([message]);
    await persistAcceptance(task, message);

    await receipt.settleEndedTurn(task);

    expect(recorder.recordConsumed).not.toHaveBeenCalled();
    expect(recorder.recordAdmissionFailure).not.toHaveBeenCalled();
    expect(task.sessionEventDeliveryEvidence?.has(message.deliveryId as string) ?? false)
      .toBe(true);
  });

  it("keeps the transcript-recovery contract when the turn-start receipt failed", async () => {
    const message = delivery("completion_notification");
    const task = makeTask();
    const { receipt, recorder } = makeReceipt([message]);
    recorder.recordTurnStarted.mockRejectedValueOnce(new Error("transient database error"));
    await persistAcceptance(task, message);

    // The observed event attempts the turn-start receipt and it fails.
    await receipt.observe(
      task,
      { type: "assistant_message", content: "consumed", timestamp: 1 } as SSEEventPayload,
    );
    await receipt.settleEndedTurn(task);

    expect(recorder.recordConsumed).not.toHaveBeenCalled();
    expect(recorder.recordAdmissionFailure).toHaveBeenCalledOnce();
  });

  it("does not close from evidence when the turn ended with a fatal error", async () => {
    const message = delivery("human_live_steer");
    const task = makeTask([], { status: "error", terminationReason: "error_aborted" });
    const { receipt, recorder } = makeReceipt([message]);
    await persistAcceptance(task, message);

    await receipt.settleEndedTurn(task);

    expect(recorder.recordTurnStarted).not.toHaveBeenCalled();
    expect(recorder.recordConsumed).not.toHaveBeenCalled();
    expect(recorder.recordAdmissionFailure).toHaveBeenCalledOnce();
    expect(task.sessionEventDeliveryEvidence?.has(message.deliveryId as string) ?? false)
      .toBe(false);
  });

  it("does not close from evidence when the interrupted turn was killed", async () => {
    const message = delivery("human_live_steer");
    const task = makeTask([], { status: "interrupted", terminationReason: "killed" });
    const { receipt, recorder } = makeReceipt([message]);
    await persistAcceptance(task, message);

    await receipt.settleEndedTurn(task);

    expect(recorder.recordConsumed).not.toHaveBeenCalled();
    expect(recorder.recordAdmissionFailure).toHaveBeenCalledOnce();
  });

  it("falls back to the admission failure when the settle-time confirmation fails", async () => {
    const message = delivery("human_live_steer");
    const task = makeTask();
    const { receipt, recorder } = makeReceipt([message]);
    recorder.recordTurnStarted.mockRejectedValueOnce(new Error("database unavailable"));
    await persistAcceptance(task, message);

    await receipt.settleEndedTurn(task);

    expect(recorder.recordConsumed).not.toHaveBeenCalled();
    expect(recorder.recordAdmissionFailure).toHaveBeenCalledOnce();
    expect(task.sessionEventDeliveryEvidence?.has(message.deliveryId as string) ?? false)
      .toBe(false);
  });

  it("never treats a runtime follow-up as session-event evidence", async () => {
    const message: InterventionMessage = {
      text: "runtime follow-up prompt",
      user: "system",
      source: "claude_runtime_task_followup",
      deliveryIntent: "runtime_followup",
      deliveryId: "99999999-9999-4999-8999-999999999999",
    };
    const task = makeTask();
    const { receipt, recorder } = makeReceipt([message]);
    await persistAcceptance(task, message);

    expect(task.sessionEventDeliveryEvidence?.has(message.deliveryId as string) ?? false)
      .toBe(false);
    await receipt.settleEndedTurn(task);

    expect(recorder.recordConsumed).not.toHaveBeenCalled();
    expect(recorder.recordAdmissionFailure).toHaveBeenCalledOnce();
  });
});

function makeExecutorHarness() {
  const persistenceDouble = makeEventPersistenceTestDouble();
  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue(null),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  return { persistence: persistenceDouble.persistence, db, broadcaster };
}

/**
 * Reproduces the operational order from card #1475 item 2: the body is
 * persisted as intervention_sent while the turn runs, the running turn accepts
 * the delivery, and this turn emits no qualifying event afterwards. The turn
 * ends normally, so no turn-start receipt was ever attempted.
 */
function steeringEngine(
  task: Task,
  message: InterventionMessage,
  persistence: EventPersistence,
): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/codex-default",
    async *execute(): AsyncIterable<SSEEventPayload> {
      await publishInterventionSent(task, message, {
        broadcaster: makeBroadcaster(),
        logger: silentLogger,
        persistence,
      });
      await task.activeDeliveryTurnReceipt?.register(message);
    },
    async interrupt() { return true; },
    async close() {},
  };
}

describe("TaskExecutor settle of a running steer", () => {
  it("closes the accepted steer as consumed instead of dead_letter", async () => {
    const harness = makeExecutorHarness();
    const message: InterventionMessage = {
      text: "steer body",
      user: "agent",
      deliveryIntent: "human_live_steer",
      deliveryId: "77777777-7777-4777-8777-777777777777",
    };
    const recorder = makeRecorder();
    const task = makeTask([], { status: "running", terminationReason: undefined });
    const executor = new TaskExecutor(
      () => steeringEngine(task, message, harness.persistence),
      harness.db,
      harness.persistence,
      harness.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      recorder,
    );

    executor.startNewExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("completed");
    expect(recorder.recordAdmissionFailure).not.toHaveBeenCalled();
    expect(recorder.recordConsumed).toHaveBeenCalledWith(
      message,
      task,
      sessionEventReceiptId(message),
    );
    expect(task.sessionEventDeliveryEvidence?.has(message.deliveryId as string) ?? false)
      .toBe(false);
  });
});
