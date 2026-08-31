import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EnginePort } from "../../src/engine/protocol.js";
import { RunnerProcessEngineProxy } from "../../src/runner/runner_process_engine_proxy.js";
import { createInProcessTaskRunnerRuntime, createTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

function makeRunningTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "s1",
    prompt: "original prompt",
    status: "running",
    profileId: "claude-default",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 3,
    interventionQueue: [],
    ...overrides,
  };
}

function makeBroadcaster(
  emitEventEnvelope = vi.fn().mockResolvedValue(undefined),
): SessionBroadcaster {
  return { emitEventEnvelope } as unknown as SessionBroadcaster;
}

describe("RunningInterventionTransition", () => {
  it("queues an idle runner notification in the normal next-turn queue without runner inbox staging", async () => {
    let task!: Task;
    const stageIntervention = vi.fn(async () => {
      expect(task.interventionQueue).toEqual([]);
      return {
        durability: "runner" as const,
        eventSourceSeq: null,
        queuePosition: 1,
      };
    });
    const waitForSessionAck = vi.fn();
    const dispatcher = {
      stageIntervention,
      waitForSessionAck,
      dispatch: vi.fn(),
      executeFrames: vi.fn(),
      prepareSession: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      detachHost: vi.fn(),
      sendControlFrame: vi.fn(),
      requestContext: vi.fn(),
    };
    task = makeRunningTask({
      runner: createTaskRunnerRuntime(
        new RunnerProcessEngineProxy("claude", "/tmp/claude", dispatcher as never),
        dispatcher as never,
        "runner",
      ),
    });
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    const message = {
      text: "child completed",
      user: "agent",
      deliveryId: "idle-runner-completion",
      deliveryIntent: "completion_notification",
      completionId: "completion-idle-runner",
      relationKey: "child_session:idle-runner:1",
      source: "completion_notifier",
    };
    await expect(transition.queueOnly(task, message, { publishEvent: false })).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "queue_only_policy",
    });

    expect(stageIntervention).not.toHaveBeenCalled();
    expect(waitForSessionAck).not.toHaveBeenCalled();
    expect(persistenceDouble.enqueueEvent).not.toHaveBeenCalled();
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.interventionQueue[0]).toEqual(message);
    expect(task.interventionQueue[0]).not.toHaveProperty("runnerInterventionId");
  });

  it("routes runner-backed no_active_turn through the public engine and next-turn queue", async () => {
    const stageIntervention = vi.fn();
    const applyIntervention = vi.fn();
    const discardIntervention = vi.fn();
    const dispatcher = {
      stageIntervention,
      applyIntervention,
      discardIntervention,
      waitForSessionAck: vi.fn(),
      dispatch: vi.fn(),
      executeFrames: vi.fn(),
      prepareSession: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      detachHost: vi.fn(),
      sendControlFrame: vi.fn(),
      requestContext: vi.fn(),
    };
    const engine = new RunnerProcessEngineProxy("codex", "/tmp/codex", dispatcher as never);
    const intervene = vi.spyOn(engine, "intervene").mockResolvedValue({
      status: "not_delivered",
      mechanism: "active_turn",
      reason: "no_active_turn",
    });
    const task = makeRunningTask({
      runner: createTaskRunnerRuntime(
        engine,
        dispatcher as never,
        "runner",
      ),
    });
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(
      transition.deliver(task, { text: "queue after no active turn", user: "soak" }),
    ).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "no_active_turn",
    });

    expect(intervene).toHaveBeenCalledOnce();
    expect(stageIntervention).not.toHaveBeenCalled();
    expect(applyIntervention).not.toHaveBeenCalled();
    expect(discardIntervention).not.toHaveBeenCalled();
    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledOnce();
    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "queue after no active turn",
      }),
    );
    expect(task.interventionQueue).toEqual([
      { text: "queue after no active turn", user: "soak" },
    ]);
  });

  it("publishes acceptance before asking a Claude adapter to intervene", async () => {
    const intervene = vi.fn().mockResolvedValue({
      status: "not_delivered",
      mechanism: "interrupt_then_next_turn",
      reason: "next_turn_required",
    });
    const task = makeRunningTask({
      runner: createInProcessTaskRunnerRuntime({
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene,
      } as unknown as EnginePort),
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(
      transition.deliver(task, {
        text: "redirect the active turn",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      }),
    ).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "next_turn_required",
    });

    expect(intervene).toHaveBeenCalledTimes(1);
    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "redirect the active turn",
      }),
    );
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([
      {
        text: "redirect the active turn",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      },
    ]);
  });

  it("delivers running interventions to a live engine and publishes intervention_sent immediately", async () => {
    const intervene = vi.fn().mockResolvedValue({
      status: "delivered",
      mechanism: "active_turn",
    });
    const task = makeRunningTask({
      runner: createInProcessTaskRunnerRuntime({
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene,
      } as unknown as EnginePort),
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(
      transition.deliver(task, {
        text: "reach the active turn",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      }),
    ).resolves.toEqual({ delivered: true });

    expect(intervene).toHaveBeenCalledWith({
      prompt: "reach the active turn\n\n[첨부 파일 로컬 경로: /tmp/a.png]",
      imageAttachmentPaths: ["/tmp/a.png"],
      turnOrigin: { kind: "user_message" },
    });
    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "reach the active turn",
        attachments: ["/tmp/a.png"],
      }),
    );
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([]);
  });

  it("does not retry a transient live-steer boundary", async () => {
    const intervene = vi
      .fn()
      .mockResolvedValueOnce({
        status: "not_delivered",
        mechanism: "active_turn",
        reason: "not_accepting_input",
      })
      .mockResolvedValueOnce({ status: "delivered", mechanism: "active_turn" });
    const task = makeRunningTask({
      runner: createInProcessTaskRunnerRuntime({
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene,
      } as unknown as EnginePort),
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(
      transition.deliver(task, { text: "safe boundary", user: "alice" }),
    ).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "not_accepting_input",
    });

    expect(intervene).toHaveBeenCalledOnce();
    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "intervention_sent", text: "safe boundary" }),
    );
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([
      { text: "safe boundary", user: "alice" },
    ]);
  });

  it("queues the next turn without cancelling when its engine reports no active turn", async () => {
    const intervene = vi.fn().mockResolvedValueOnce({
      status: "not_delivered",
      mechanism: "active_turn",
      reason: "no_active_turn",
    });
    const interrupt = vi.fn().mockResolvedValue(true);
    const task = makeRunningTask({
      runner: createInProcessTaskRunnerRuntime({
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        interrupt,
        async close() {},
        intervene,
      } as unknown as EnginePort),
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(
      transition.deliver(task, { text: "queue after unsafe boundary", user: "alice" }),
    ).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "no_active_turn",
    });

    expect(intervene).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "queue after unsafe boundary",
      }),
    );
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([
      { text: "queue after unsafe boundary", user: "alice" },
    ]);
  });

  it("falls back to the next-turn queue when the engine has no live delivery surface", async () => {
    const task = makeRunningTask();
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(
      transition.deliver(task, {
        text: "next turn only",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      }),
    ).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "not_supported",
    });

    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "next turn only",
      }),
    );
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([
      {
        text: "next turn only",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      },
    ]);
  });

  it("logs final non-delivery with its reason, consumption point, and backlog", async () => {
    const info = vi.fn();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: { info, warn: vi.fn(), debug: vi.fn() } as never,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await transition.deliver(
      makeRunningTask(),
      { text: "observe the miss", user: "alice" },
    );

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        delivered: false,
        mechanism: "unsupported",
        reason: "not_supported",
        queuePosition: 1,
        consumeWhen: "next_turn",
      }),
      "running intervention not delivered; queued for next turn",
    );
  });

  it("preserves FIFO order and message metadata for the next query turn", async () => {
    const task = makeRunningTask({
      interventionQueue: [{ text: "first", user: "bob" }],
    });
    const callerInfo = { source: "slack", display_name: "Alice" };
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(
      transition.deliver(task, {
        text: "second",
        user: "alice",
        callerInfo,
        attachmentPaths: ["/tmp/a.png", "/tmp/a.pdf"],
        context: [{ title: "trace", body: "line 1" }],
      }),
    ).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 2,
      consumeWhen: "next_turn",
      reason: "not_supported",
    });

    expect(task.interventionQueue).toEqual([
      { text: "first", user: "bob" },
      {
        text: "second",
        user: "alice",
        callerInfo,
        attachmentPaths: ["/tmp/a.png", "/tmp/a.pdf"],
        context: [{ title: "trace", body: "line 1" }],
      },
    ]);
  });

  it("can defer durable callers without mutating the queue", async () => {
    const task = makeRunningTask();
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(
      transition.deliver(
        task,
        { text: "durable caller will retry", user: "alice" },
        { queueIfUndelivered: false },
      ),
    ).resolves.toEqual({
      delivered: false,
      deferred: true,
      retryWhen: "engine_available",
      reason: "not_supported",
    });

    expect(task.interventionQueue).toEqual([]);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("does not deliver or queue an accepted intervention when persistence fails", async () => {
    const intervene = vi.fn().mockResolvedValue({
      status: "delivered",
      mechanism: "active_turn",
    });
    const task = makeRunningTask({
      runner: createInProcessTaskRunnerRuntime({
        backendId: "codex",
        workspaceDir: "/tmp/codex",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene,
      } as unknown as EnginePort),
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence: {
        enqueueEvent: vi.fn().mockRejectedValue(new Error("events DB unavailable")),
        handleSideEffects: vi.fn(),
      } as never,
    });

    await expect(
      transition.deliver(task, { text: "must be durable", user: "alice" }),
    ).rejects.toThrow("events DB unavailable");

    expect(intervene).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([]);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("defers durable callers without retrying or cancelling when queueing is disabled", async () => {
    const intervene = vi
      .fn()
      .mockResolvedValueOnce({
        status: "not_delivered",
        mechanism: "active_turn",
        reason: "not_accepting_input",
      })
      .mockResolvedValueOnce({
        status: "not_delivered",
        mechanism: "active_turn",
        reason: "no_active_turn",
      });
    const interrupt = vi.fn().mockResolvedValue(true);
    const task = makeRunningTask({
      runner: createInProcessTaskRunnerRuntime({
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        interrupt,
        async close() {},
        intervene,
      } as unknown as EnginePort),
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(
      transition.deliver(
        task,
        { text: "durable retry after boundary", user: "alice" },
        { queueIfUndelivered: false },
      ),
    ).resolves.toEqual({
      delivered: false,
      deferred: true,
      retryWhen: "engine_available",
      reason: "not_accepting_input",
    });

    expect(intervene).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([]);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

});
