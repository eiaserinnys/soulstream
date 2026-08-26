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
  it("mirrors an idle runner notification durably before exposing it in memory", async () => {
    let task!: Task;
    const stageIntervention = vi.fn(async () => {
      expect(task.interventionQueue).toEqual([]);
      return {
        durability: "runner" as const,
        eventSourceSeq: null,
        queuePosition: 1,
      };
    });
    const dispatcher = {
      stageIntervention,
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
    task = makeRunningTask({
      runner: createTaskRunnerRuntime(
        new RunnerProcessEngineProxy("claude", "/tmp/claude", dispatcher as never),
        dispatcher as never,
        "runner",
      ),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await expect(transition.queueOnly(task, {
      text: "child completed",
      user: "agent",
      deliveryId: "idle-runner-completion",
      deliveryIntent: "completion_notification",
      completionId: "completion-idle-runner",
      relationKey: "child_session:idle-runner:1",
      source: "completion_notifier",
    }, { publishEvent: false })).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "queue_only_policy",
    });

    expect(stageIntervention).toHaveBeenCalledWith(expect.objectContaining({
      queued: true,
      message: expect.objectContaining({
        deliveryId: "idle-runner-completion",
        deliveryIntent: "completion_notification",
      }),
    }));
    expect(stageIntervention.mock.calls[0]?.[0]).not.toHaveProperty("event");
    expect(task.interventionQueue).toEqual([
      expect.objectContaining({
        deliveryId: "idle-runner-completion",
        runnerInterventionId: expect.any(String),
      }),
    ]);
  });

  it.each([
    // Live backend behavior is measured separately; atom card
    // 6723db5e-b9c8-4095-9563-e819664991ca is the canonical evidence.
    {
      backendId: "claude" as const,
      engineResult: {
        status: "not_delivered",
        mechanism: "interrupt_then_next_turn",
        reason: "next_turn_required",
      },
      expected: {
        delivered: false,
        queued: true,
        queuePosition: 1,
        consumeWhen: "next_turn",
        reason: "next_turn_required",
      },
    },
    {
      backendId: "codex" as const,
      engineResult: {
        status: "delivered",
        mechanism: "active_turn",
      },
      expected: {
        delivered: true,
      },
    },
  ])(
    "$backendId intervention has the same outcome through in-process and runner paths",
    async ({ backendId, engineResult, expected }) => {
      const intervene = vi.fn().mockResolvedValue(engineResult);
      const adapter = {
        backendId,
        workspaceDir: `/tmp/${backendId}`,
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene,
      } as unknown as EnginePort;
      const stageIntervention = vi.fn(async (input: { queued: boolean; event?: unknown }) => ({
        eventSourceSeq: input.event ? 42 : null,
        queuePosition: input.queued ? 1 : 0,
      }));
      const waitForSessionAck = vi.fn().mockResolvedValue(142);
      const applyIntervention = vi.fn(async ({ input }: { input: unknown }) => {
        return await intervene(input);
      });
      const dispatcher = {
        stageIntervention,
        applyIntervention,
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
      const transition = new RunningInterventionTransition({
        broadcaster: makeBroadcaster(),
        logger: silentLogger,
        persistence: makeEventPersistenceTestDouble().persistence,
        liveRetryDelayMs: 0,
      });
      const inProcessTask = makeRunningTask({
        runner: createInProcessTaskRunnerRuntime(adapter),
      });
      const runnerTask = makeRunningTask({
        runner: createTaskRunnerRuntime(
          new RunnerProcessEngineProxy(backendId, `/tmp/${backendId}`, dispatcher as never),
          dispatcher as never,
          "runner",
        ),
      });

      const inProcessResult = await transition.deliver(
        inProcessTask,
        { text: `redirect ${backendId}`, user: "alice" },
      );
      const runnerResult = await transition.deliver(
        runnerTask,
        { text: `redirect ${backendId}`, user: "alice" },
      );

      expect(inProcessResult).toEqual(expected);
      expect(runnerResult).toEqual(expected);
      expect(intervene).toHaveBeenCalledTimes(2);
      expect(applyIntervention).toHaveBeenCalledWith(expect.objectContaining({
        interventionId: expect.any(String),
        input: expect.objectContaining({
          prompt: `redirect ${backendId}`,
          imageAttachmentPaths: [],
          turnOrigin: expect.objectContaining({ kind: "user_message" }),
        }),
      }));
      if (backendId === "claude") {
        expect(stageIntervention).toHaveBeenNthCalledWith(1, expect.objectContaining({
          queued: false,
          event: expect.objectContaining({ type: "intervention_sent" }),
        }));
        expect(stageIntervention).toHaveBeenNthCalledWith(2, expect.objectContaining({
          queued: true,
        }));
        expect(runnerTask.interventionQueue).toHaveLength(1);
      } else {
        expect(stageIntervention).toHaveBeenCalledTimes(1);
        expect(stageIntervention).toHaveBeenCalledWith(expect.objectContaining({
          queued: false,
          event: expect.objectContaining({ type: "intervention_sent" }),
        }));
        expect(runnerTask.interventionQueue).toEqual([]);
      }
    },
  );

  it("keeps queueIfUndelivered=false equivalent across in-process and runner paths", async () => {
    const verdict = {
      status: "not_delivered" as const,
      mechanism: "unsupported" as const,
      reason: "not_supported" as const,
    };
    const intervene = vi.fn().mockResolvedValue(verdict);
    const adapter = {
      backendId: "codex" as const,
      workspaceDir: "/tmp/codex",
      async *execute(): AsyncIterable<never> {},
      async interrupt() { return true; },
      async close() {},
      intervene,
    } as unknown as EnginePort;
    const stageIntervention = vi.fn(async (input: { queued: boolean; event?: unknown }) => ({
      eventSourceSeq: input.event ? 42 : null,
      queuePosition: input.queued ? 1 : 0,
    }));
    const discardIntervention = vi.fn().mockResolvedValue(undefined);
    const dispatcher = {
      stageIntervention,
      applyIntervention: vi.fn().mockResolvedValue(verdict),
      discardIntervention,
      waitForSessionAck: vi.fn().mockResolvedValue(142),
      dispatch: vi.fn(),
      executeFrames: vi.fn(),
      prepareSession: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      detachHost: vi.fn(),
      sendControlFrame: vi.fn(),
      requestContext: vi.fn(),
    };
    const inProcessTask = makeRunningTask({
      runner: createInProcessTaskRunnerRuntime(adapter),
    });
    const runnerTask = makeRunningTask({
      runner: createTaskRunnerRuntime(
        new RunnerProcessEngineProxy("codex", "/tmp/codex", dispatcher as never),
        dispatcher as never,
        "runner",
      ),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });
    const expected = {
      delivered: false,
      deferred: true,
      retryWhen: "engine_available",
      reason: "not_supported",
    };

    await expect(transition.deliver(
      inProcessTask,
      { text: "do not queue", user: "scheduler" },
      { queueIfUndelivered: false },
    )).resolves.toEqual(expected);
    await expect(transition.deliver(
      runnerTask,
      { text: "do not queue", user: "scheduler" },
      { queueIfUndelivered: false },
    )).resolves.toEqual(expected);
    expect(inProcessTask.interventionQueue).toEqual([]);
    expect(runnerTask.interventionQueue).toEqual([]);
    expect(stageIntervention).toHaveBeenCalledOnce();
    expect(discardIntervention).toHaveBeenCalledOnce();
  });

  it("attempts runner delivery before durably queueing an undelivered intervention", async () => {
    const stageIntervention = vi.fn(async (input: { queued: boolean; event?: unknown }) => ({
      eventSourceSeq: input.event ? 42 : null,
      queuePosition: input.queued ? 1 : 0,
    }));
    const waitForSessionAck = vi.fn().mockResolvedValue(142);
    const applyIntervention = vi.fn().mockResolvedValue({
      status: "not_delivered",
      mechanism: "interrupt_then_next_turn",
      reason: "next_turn_required",
    });
    const dispatcher = {
      stageIntervention,
      applyIntervention,
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
    const task = makeRunningTask({
      runner: createTaskRunnerRuntime(
        new RunnerProcessEngineProxy("codex", "/tmp/codex", dispatcher as never),
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
      transition.deliver(task, { text: "durable after adopt", user: "soak" }),
    ).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "next_turn_required",
    });

    expect(stageIntervention).toHaveBeenNthCalledWith(1, {
      interventionId: expect.any(String),
      message: expect.objectContaining({
        text: "durable after adopt",
        user: "soak",
        runnerInterventionId: expect.any(String),
      }),
      event: expect.objectContaining({
        type: "intervention_sent",
        text: "durable after adopt",
      }),
      queued: false,
    });
    expect(stageIntervention).toHaveBeenNthCalledWith(2, {
      interventionId: expect.any(String),
      message: expect.objectContaining({
        text: "durable after adopt",
        runnerInterventionId: expect.any(String),
      }),
      queued: true,
    });
    expect(stageIntervention.mock.invocationCallOrder[0]).toBeLessThan(
      waitForSessionAck.mock.invocationCallOrder[0],
    );
    expect(waitForSessionAck.mock.invocationCallOrder[0]).toBeLessThan(
      applyIntervention.mock.invocationCallOrder[0],
    );
    expect(applyIntervention.mock.invocationCallOrder[0]).toBeLessThan(
      stageIntervention.mock.invocationCallOrder[1],
    );
    expect(task.lastEventId).toBe(142);
    expect(task.interventionQueue).toEqual([
      expect.objectContaining({
        text: "durable after adopt",
        runnerInterventionId: expect.any(String),
      }),
    ]);
    expect(persistenceDouble.enqueueEvent).not.toHaveBeenCalled();
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

  it("keeps the queued message when intervention races with turn completion", async () => {
    const intervene = vi.fn().mockResolvedValue({
      status: "not_delivered",
      mechanism: "interrupt_then_next_turn",
      reason: "no_active_turn",
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
    const persistenceDouble = makeEventPersistenceTestDouble();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(
      transition.deliver(task, { text: "race-safe steer", user: "alice" }),
    ).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "no_active_turn",
    });

    expect(intervene).toHaveBeenCalledTimes(2);
    expect(task.interventionQueue).toEqual([{ text: "race-safe steer", user: "alice" }]);
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

  it("retries one transient live-steer boundary before falling back", async () => {
    const intervene = vi
      .fn()
      .mockResolvedValueOnce({
        status: "not_delivered",
        mechanism: "active_turn",
        reason: "not_accepting_input",
      })
      .mockResolvedValueOnce({ status: "delivered", mechanism: "active_turn" });
    const sleep = vi.fn().mockResolvedValue(undefined);
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
      liveRetryDelayMs: 25,
      sleep,
    });

    await expect(
      transition.deliver(task, { text: "safe boundary", user: "alice" }),
    ).resolves.toEqual({ delivered: true });

    expect(sleep).toHaveBeenCalledWith(25);
    expect(intervene).toHaveBeenCalledTimes(2);
    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "intervention_sent", text: "safe boundary" }),
    );
    expect(emitEventEnvelope).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([]);
  });

  it("falls back to the next-turn queue when transient live-steer boundary remains unsafe", async () => {
    const intervene = vi
      .fn()
      .mockResolvedValueOnce({
        status: "not_delivered",
        mechanism: "active_turn",
        reason: "no_active_turn",
      })
      .mockResolvedValueOnce({
        status: "not_delivered",
        mechanism: "active_turn",
        reason: "not_accepting_input",
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
      liveRetryDelayMs: 0,
    });

    await expect(
      transition.deliver(task, { text: "queue after unsafe boundary", user: "alice" }),
    ).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "not_accepting_input",
    });

    expect(intervene).toHaveBeenCalledTimes(2);
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

  it("defer durable callers after a transient live-steer retry still cannot deliver", async () => {
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
    const sleep = vi.fn().mockResolvedValue(undefined);
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
      liveRetryDelayMs: 10,
      sleep,
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
      reason: "no_active_turn",
    });

    expect(sleep).toHaveBeenCalledWith(10);
    expect(intervene).toHaveBeenCalledTimes(2);
    expect(task.interventionQueue).toEqual([]);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "delivered",
      verdict: { status: "delivered", mechanism: "active_turn" } as const,
      expected: { delivered: true } as const,
      discardCalls: 0,
    },
    {
      label: "not delivered",
      verdict: {
        status: "not_delivered",
        mechanism: "unsupported",
        reason: "not_supported",
      } as const,
      expected: {
        delivered: false,
        deferred: true,
        retryWhen: "engine_available",
        reason: "not_supported",
      } as const,
      discardCalls: 1,
    },
    {
      label: "unknown",
      verdict: { status: "unknown", reason: "verdict_unknown" } as const,
      expected: {
        delivered: false,
        deferred: true,
        retryWhen: "engine_available",
        reason: "verdict_unknown",
      } as const,
      discardCalls: 1,
    },
  ])(
    "process runner with queueIfUndelivered=false reaches the engine and resolves $label",
    async ({ verdict, expected, discardCalls }) => {
      const stageIntervention = vi.fn().mockResolvedValue({
        eventSourceSeq: 42,
        queuePosition: 0,
      });
      const waitForSessionAck = vi.fn().mockResolvedValue(142);
      const applyIntervention = vi.fn().mockResolvedValue(verdict);
      const discardIntervention = vi.fn().mockResolvedValue(undefined);
      const dispatcher = {
        stageIntervention,
        waitForSessionAck,
        applyIntervention,
        discardIntervention,
        dispatch: vi.fn(),
        executeFrames: vi.fn(),
        prepareSession: vi.fn(),
        interrupt: vi.fn(),
        close: vi.fn(),
        detachHost: vi.fn(),
        sendControlFrame: vi.fn(),
        requestContext: vi.fn(),
      };
      const task = makeRunningTask({
        runner: createTaskRunnerRuntime(
          new RunnerProcessEngineProxy("codex", "/tmp/codex", dispatcher as never),
          dispatcher as never,
          "runner",
        ),
      });
      const transition = new RunningInterventionTransition({
        broadcaster: makeBroadcaster(),
        logger: silentLogger,
        persistence: makeEventPersistenceTestDouble().persistence,
      });

      await expect(transition.deliver(
        task,
        { text: "scheduled while running", user: "scheduler" },
        { queueIfUndelivered: false },
      )).resolves.toEqual(expected);

      expect(stageIntervention).toHaveBeenCalledOnce();
      expect(stageIntervention).toHaveBeenCalledWith(expect.objectContaining({
        queued: false,
        event: expect.objectContaining({ type: "intervention_sent" }),
      }));
      expect(waitForSessionAck).toHaveBeenCalledOnce();
      expect(applyIntervention).toHaveBeenCalledOnce();
      expect(stageIntervention.mock.invocationCallOrder[0]).toBeLessThan(
        applyIntervention.mock.invocationCallOrder[0],
      );
      expect(discardIntervention).toHaveBeenCalledTimes(discardCalls);
      expect(task.interventionQueue).toEqual([]);
    },
  );

  it("queues an unknown verdict when durable discard cannot confirm the caller policy", async () => {
    const dispatcher = {
      stageIntervention: vi.fn(async (input: { queued: boolean; event?: unknown }) => ({
        eventSourceSeq: input.event ? 42 : null,
        queuePosition: input.queued ? 1 : 0,
      })),
      waitForSessionAck: vi.fn().mockResolvedValue(142),
      applyIntervention: vi.fn().mockResolvedValue({
        status: "not_delivered",
        mechanism: "unsupported",
        reason: "not_supported",
      }),
      discardIntervention: vi.fn().mockRejectedValue(
        new Error("Runner IPC request timed out after 30000ms"),
      ),
      dispatch: vi.fn(),
      executeFrames: vi.fn(),
      prepareSession: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      detachHost: vi.fn(),
      sendControlFrame: vi.fn(),
      requestContext: vi.fn(),
    };
    const task = makeRunningTask({
      runner: createTaskRunnerRuntime(
        new RunnerProcessEngineProxy("codex", "/tmp/codex", dispatcher as never),
        dispatcher as never,
        "runner",
      ),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await expect(transition.deliver(
      task,
      { text: "scheduled while running", user: "scheduler" },
      { queueIfUndelivered: false },
    )).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "verdict_unknown",
    });
    expect(dispatcher.stageIntervention).toHaveBeenCalledTimes(2);
    expect(dispatcher.stageIntervention).toHaveBeenLastCalledWith(expect.objectContaining({
      queued: true,
    }));
    expect(task.interventionQueue).toHaveLength(1);
  });

  it("queues an unknown runner verdict so the durable fence reaches the next turn", async () => {
    const timeout = new Error("Runner IPC request timed out after 30000ms");
    const stageIntervention = vi.fn(async (input: { queued: boolean; event?: unknown }) => ({
      eventSourceSeq: input.event ? 42 : null,
      queuePosition: input.queued ? 1 : 0,
    }));
    const waitForSessionAck = vi.fn().mockResolvedValue(142);
    const applyIntervention = vi.fn().mockRejectedValue(timeout);
    const dispatcher = {
      stageIntervention,
      applyIntervention,
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
    const task = makeRunningTask({
      runner: createTaskRunnerRuntime(
        new RunnerProcessEngineProxy("codex", "/tmp/codex", dispatcher as never),
        dispatcher as never,
        "runner",
      ),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await expect(Promise.race([
      transition.deliver(task, { text: "do not duplicate", user: "alice" }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("delivery verdict remained pending")),
        50,
      )),
    ])).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "verdict_unknown",
    });

    expect(stageIntervention).toHaveBeenCalledTimes(2);
    expect(stageIntervention).toHaveBeenLastCalledWith(expect.objectContaining({
      queued: true,
    }));
    expect(applyIntervention).toHaveBeenCalledTimes(1);
    expect(task.interventionQueue).toHaveLength(1);
  });

  it.each([
    {
      boundary: "receipt command",
      stageIntervention: vi.fn()
        .mockRejectedValueOnce(new Error("Runner IPC request timed out after 30000ms"))
        .mockResolvedValueOnce({ eventSourceSeq: 43, queuePosition: 1 }),
      waitForSessionAck: vi.fn().mockResolvedValue(143),
    },
    {
      boundary: "receipt host ACK",
      stageIntervention: vi.fn()
        .mockResolvedValueOnce({ eventSourceSeq: 42, queuePosition: 0 })
        .mockResolvedValueOnce({ eventSourceSeq: 42, queuePosition: 1 }),
      waitForSessionAck: vi.fn()
        .mockRejectedValueOnce(new Error("Runner receipt ACK timed out"))
        .mockResolvedValueOnce(143),
    },
  ])("recovers a durable $boundary timeout into the next-turn queue", async ({
    stageIntervention,
    waitForSessionAck,
  }) => {
    const applyIntervention = vi.fn();
    const dispatcher = {
      stageIntervention,
      applyIntervention,
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
    const task = makeRunningTask({
      runner: createTaskRunnerRuntime(
        new RunnerProcessEngineProxy("codex", "/tmp/codex", dispatcher as never),
        dispatcher as never,
        "runner",
      ),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await expect(transition.deliver(
      task,
      { text: "receipt verdict unknown", user: "alice" },
    )).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "verdict_unknown",
    });
    expect(stageIntervention).toHaveBeenCalledTimes(2);
    expect(stageIntervention).toHaveBeenLastCalledWith(expect.objectContaining({
      queued: true,
      event: expect.objectContaining({ type: "intervention_sent" }),
    }));
    expect(applyIntervention).not.toHaveBeenCalled();
    expect(task.interventionQueue).toHaveLength(1);
  });

  it("keeps the no-queue policy when an unknown receipt can be discarded", async () => {
    const dispatcher = {
      stageIntervention: vi.fn().mockResolvedValue({
        eventSourceSeq: 42,
        queuePosition: 0,
      }),
      waitForSessionAck: vi.fn().mockRejectedValue(new Error("receipt ACK timed out")),
      applyIntervention: vi.fn(),
      discardIntervention: vi.fn().mockResolvedValue(undefined),
      dispatch: vi.fn(),
      executeFrames: vi.fn(),
      prepareSession: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      detachHost: vi.fn(),
      sendControlFrame: vi.fn(),
      requestContext: vi.fn(),
    };
    const task = makeRunningTask({
      runner: createTaskRunnerRuntime(
        new RunnerProcessEngineProxy("codex", "/tmp/codex", dispatcher as never),
        dispatcher as never,
        "runner",
      ),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await expect(transition.deliver(
      task,
      { text: "scheduler owns retry", user: "scheduler" },
      { queueIfUndelivered: false },
    )).resolves.toEqual({
      delivered: false,
      deferred: true,
      retryWhen: "engine_available",
      reason: "verdict_unknown",
    });
    expect(dispatcher.applyIntervention).not.toHaveBeenCalled();
    expect(dispatcher.discardIntervention).toHaveBeenCalledOnce();
    expect(task.interventionQueue).toEqual([]);
  });

  it("returns an honest unknown verdict when receipt recovery also fails", async () => {
    const stageIntervention = vi.fn()
      .mockRejectedValueOnce(new Error("receipt command timed out"))
      .mockRejectedValueOnce(new Error("receipt recovery timed out"));
    const dispatcher = {
      stageIntervention,
      applyIntervention: vi.fn(),
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
    const task = makeRunningTask({
      runner: createTaskRunnerRuntime(
        new RunnerProcessEngineProxy("codex", "/tmp/codex", dispatcher as never),
        dispatcher as never,
        "runner",
      ),
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    } as unknown as typeof silentLogger;
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await expect(transition.deliver(
      task,
      { text: "keep this in the central delivery", user: "alice" },
    )).resolves.toEqual({
      delivered: null,
      reason: "verdict_unknown",
      consumeWhen: null,
    });
    expect(task.interventionQueue).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        interventionId: expect.any(String),
      }),
      "runner intervention durable queue recovery failed; verdict remains unknown",
    );
  });
});
