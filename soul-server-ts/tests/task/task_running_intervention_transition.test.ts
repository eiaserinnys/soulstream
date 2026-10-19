import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EnginePort } from "../../src/engine/protocol.js";
import { RunnerProcessEngineProxy } from "../../src/runner/runner_process_engine_proxy.js";
import { createInProcessTaskRunnerRuntime, createTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";
import { resolveTurnLoopTransition } from "../../src/task/task_turn_loop_transition.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { TaskDeliveryConsumption } from "../../src/task/task_delivery_consumption.js";
import { TaskDeliveryTurnReceipt } from "../../src/task/task_delivery_turn_receipt.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { PrepareAttachmentInput } from "../../src/task/prepare_attachment_input.js";
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
    executionRegistration: {
      ownerKind: "in_process",
      manifestId: "manifest:s1",
      runtimeEnvIdentity: "runtime:s1",
      registrationId: "registration:s1",
      pid: 42_201,
      startIdentity: "start:s1",
      executionCommandId: "command:s1",
      ownershipGeneration: 1,
    },
    ...overrides,
  };
}

function makeBroadcaster(
  emitEventEnvelope = vi.fn().mockResolvedValue(undefined),
): SessionBroadcaster {
  return { emitEventEnvelope } as unknown as SessionBroadcaster;
}

function makeManagedInterventionMessage(): InterventionMessage {
  return {
    text: "read the attached file",
    user: "worker",
    callerInfo: { source: "agent", agent_id: "worker" },
    attachmentPaths: ["/tmp/incoming/a.png"],
    attachmentIds: ["att-a"],
    attachmentBindings: [
      { attachment_id: "att-a", node_id: "node-1", path: "/tmp/incoming/a.png" },
    ],
    deliveryId: "delivery-a",
  };
}

describe("RunningInterventionTransition", () => {
  it.each(["browser", "agent", "system"])("interrupts Antigravity for %s input and immediately prepares the next turn", async source => {
    const intervene = vi.fn().mockResolvedValue({ status: "not_delivered", mechanism: "interrupt_then_next_turn", reason: "next_turn_required" });
    const injectAtToolBoundary = vi.fn();
    const task = makeRunningTask({ modelPresetBackend: "antigravity", runner: createInProcessTaskRunnerRuntime({
      backendId: "antigravity", workspaceDir: "/tmp/agy", async *execute() {}, async interrupt() { return true; }, async close() {}, intervene, injectAtToolBoundary,
    } as unknown as EnginePort) });
    const transition = new RunningInterventionTransition({ broadcaster: makeBroadcaster(), logger: silentLogger, persistence: makeEventPersistenceTestDouble().persistence });
    const message = { text: "새 정보로 계속", user: source, callerInfo: { source }, ...(source === "system" ? { deliveryIntent: "completion_notification" as const } : {}) };
    const outcome = await transition.deliver(task, message);
    expect(outcome).toMatchObject({ delivered: false, queued: true, reason: "next_turn_required" });
    await task.interruptRequest;
    expect(intervene).toHaveBeenCalledOnce();
    expect(injectAtToolBoundary).not.toHaveBeenCalled();
    expect(task.status).toBe("running");
    expect(resolveTurnLoopTransition(task, { id: "test", name: "시험", backend: "antigravity", workspace_dir: "/tmp/agy" })).toMatchObject({ kind: "continue", prompt: expect.stringContaining("새 정보로 계속") });
  });
  it.each([
    {
      label: "an agent report whose delivery metadata still looks human",
      message: {
        text: "delegated report",
        user: "roselin",
        callerInfo: { source: "agent", agent_id: "roselin" },
        deliveryId: "delivery-agent-report",
        deliveryIntent: "human_live_steer" as const,
      },
      turnOrigin: { kind: "user_message", id: "delivery-agent-report" },
    },
    {
      label: "a system runtime follow-up",
      message: {
        text: "background task completed",
        user: "system",
        callerInfo: { source: "system" },
        source: "claude_runtime_task_followup",
        deliveryId: "delivery-runtime-followup",
        deliveryIntent: "runtime_followup" as const,
      },
      turnOrigin: { kind: "runtime_followup", id: "delivery-runtime-followup" },
    },
  ])("injects $label at the tool boundary without interrupting", async ({ message, turnOrigin }) => {
    const intervene = vi.fn();
    const injectAtToolBoundary = vi.fn().mockResolvedValue({
      status: "delivered",
      mechanism: "active_turn",
    });
    const register = vi.fn().mockResolvedValue(undefined);
    const task = makeRunningTask({
      activeDeliveryTurnReceipt: { register } as never,
      runner: createInProcessTaskRunnerRuntime({
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene,
        injectAtToolBoundary,
      } as unknown as EnginePort),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await expect(transition.deliver(task, message)).resolves.toEqual({ delivered: true });

    expect(intervene).not.toHaveBeenCalled();
    expect(injectAtToolBoundary).toHaveBeenCalledOnce();
    expect(injectAtToolBoundary).toHaveBeenCalledWith(expect.objectContaining({
      prompt: message.text,
      turnOrigin,
    }));
    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(message);
  });

  it("consumes a delivered runtime follow-up only after its tool-boundary turn receipt", async () => {
    const message = {
      text: "background task completed",
      user: "system",
      callerInfo: { source: "system" },
      source: "claude_runtime_task_followup",
      deliveryId: "delivery-runtime-receipt",
      deliveryIntent: "runtime_followup" as const,
    };
    const recorder = {
      recordConsumed: vi.fn().mockResolvedValue(undefined),
      recordTurnStarted: vi.fn().mockResolvedValue(undefined),
      discardIfConsumed: vi.fn().mockResolvedValue(false),
      recordConsumptionFailure: vi.fn().mockResolvedValue(undefined),
      recordRuntimeFollowupRelationConsumed: vi.fn().mockResolvedValue(false),
    };
    const receipt = new TaskDeliveryTurnReceipt(
      new TaskDeliveryConsumption(recorder, silentLogger),
      [],
    );
    const injectAtToolBoundary = vi.fn().mockResolvedValue({
      status: "delivered",
      mechanism: "active_turn",
    });
    const task = makeRunningTask({
      activeDeliveryTurnReceipt: receipt,
      runner: createInProcessTaskRunnerRuntime({
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene: vi.fn(),
        injectAtToolBoundary,
      } as unknown as EnginePort),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await expect(transition.deliver(task, message)).resolves.toEqual({ delivered: true });
    expect(injectAtToolBoundary).toHaveBeenCalledOnce();
    expect(recorder.recordTurnStarted).not.toHaveBeenCalled();
    expect(recorder.recordConsumed).not.toHaveBeenCalled();

    await receipt.observe(task, {
      type: "assistant_message",
      content: "turn continued after delivery",
      timestamp: 1,
    });

    expect(recorder.recordTurnStarted).toHaveBeenCalledWith(message, task);
    expect(recorder.recordConsumed).toHaveBeenCalledWith(message, task, "event:7");
    expect(receipt.hasConsumptionReceipt(message)).toBe(true);
  });

  it.each(["slack", "browser", "soul-app"])(
    "injects Claude input from caller source %s at the tool boundary",
    async (source) => {
      const intervene = vi.fn().mockResolvedValue({
        status: "not_delivered",
        mechanism: "interrupt_then_next_turn",
        reason: "next_turn_required",
      });
      const injectAtToolBoundary = vi.fn().mockResolvedValue({
        status: "delivered",
        mechanism: "active_turn",
      });
      const message: InterventionMessage = {
        text: "human live steer",
        user: "alice",
        callerInfo: { source },
      };
      const register = vi.fn().mockResolvedValue(undefined);
      const persistenceDouble = makeEventPersistenceTestDouble();
      const task = makeRunningTask({
        activeDeliveryTurnReceipt: { register } as never,
        runner: createInProcessTaskRunnerRuntime({
          backendId: "claude",
          workspaceDir: "/tmp/claude",
          async *execute(): AsyncIterable<never> {},
          async interrupt() { return true; },
          async close() {},
          intervene,
          injectAtToolBoundary,
        } as unknown as EnginePort),
      });
      const transition = new RunningInterventionTransition({
        broadcaster: makeBroadcaster(),
        logger: silentLogger,
        persistence: persistenceDouble.persistence,
      });

      await expect(transition.deliver(task, message)).resolves.toEqual({ delivered: true });

      expect(intervene).not.toHaveBeenCalled();
      expect(injectAtToolBoundary).toHaveBeenCalledOnce();
      expect(injectAtToolBoundary).toHaveBeenCalledWith(expect.objectContaining({
        prompt: message.text,
      }));
      expect(task.interventionQueue).toEqual([]);
      expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
        task.agentSessionId,
        expect.objectContaining({ type: "intervention_sent", text: message.text }),
        undefined,
        task.executionRegistration?.registrationId,
      );
      expect(register).toHaveBeenCalledOnce();
      expect(register).toHaveBeenCalledWith(message);
    },
  );

  it.each([
    {
      label: "missing caller info",
      message: { text: "legacy message", user: "alice" },
    },
    {
      label: "missing caller source",
      message: { text: "legacy message", user: "alice", callerInfo: {} },
    },
    {
      label: "null caller source",
      message: { text: "legacy message", user: "alice", callerInfo: { source: null } },
    },
    {
      label: "explicit stop wording",
      message: { text: "멈춰", user: "alice", callerInfo: { source: "browser" } },
    },
  ] satisfies Array<{ label: string; message: InterventionMessage }>)(
    "injects Claude input unchanged for $label",
    async ({ message }) => {
      const intervene = vi.fn().mockResolvedValue({
        status: "not_delivered",
        mechanism: "interrupt_then_next_turn",
        reason: "next_turn_required",
      });
      const injectAtToolBoundary = vi.fn().mockResolvedValue({
        status: "delivered",
        mechanism: "active_turn",
      });
      const register = vi.fn().mockResolvedValue(undefined);
      const persistenceDouble = makeEventPersistenceTestDouble();
      const task = makeRunningTask({
        activeDeliveryTurnReceipt: { register } as never,
        runner: createInProcessTaskRunnerRuntime({
          backendId: "claude",
          workspaceDir: "/tmp/claude",
          async *execute(): AsyncIterable<never> {},
          async interrupt() { return true; },
          async close() {},
          intervene,
          injectAtToolBoundary,
        } as unknown as EnginePort),
      });
      const transition = new RunningInterventionTransition({
        broadcaster: makeBroadcaster(),
        logger: silentLogger,
        persistence: persistenceDouble.persistence,
      });

      await expect(transition.deliver(task, message)).resolves.toEqual({ delivered: true });

      expect(intervene).not.toHaveBeenCalled();
      expect(injectAtToolBoundary).toHaveBeenCalledOnce();
      expect(injectAtToolBoundary).toHaveBeenCalledWith(expect.objectContaining({
        prompt: message.text,
      }));
      expect(task.interventionQueue).toEqual([]);
      expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
        task.agentSessionId,
        expect.objectContaining({ type: "intervention_sent", text: message.text }),
        undefined,
        task.executionRegistration?.registrationId,
      );
      expect(register).toHaveBeenCalledOnce();
      expect(register).toHaveBeenCalledWith(message);
    },
  );

  it.each(["system", "browser"])(
    "falls back to interrupt when the active engine lacks the push-only capability for %s input",
    async (source) => {
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
      const transition = new RunningInterventionTransition({
        broadcaster: makeBroadcaster(),
        logger: silentLogger,
        persistence: makeEventPersistenceTestDouble().persistence,
      });

      await expect(transition.deliver(task, {
        text: "report while engine is unavailable",
        user: source,
        callerInfo: { source },
        deliveryId: "delivery-idle-machine-report",
      })).resolves.toEqual({ delivered: true });

      expect(intervene).toHaveBeenCalledOnce();
    },
  );

  it("falls back to interrupt when an old runner reports tool-boundary injection unsupported", async () => {
    const intervene = vi.fn().mockResolvedValue({
      status: "delivered",
      mechanism: "active_turn",
    });
    const injectAtToolBoundary = vi.fn().mockResolvedValue({
      status: "not_delivered",
      mechanism: "unsupported",
      reason: "not_supported",
    });
    const task = makeRunningTask({
      runner: createInProcessTaskRunnerRuntime({
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene,
        injectAtToolBoundary,
      } as unknown as EnginePort),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await expect(transition.deliver(task, {
      text: "report during a rolling deployment",
      user: "system",
      callerInfo: { source: "system" },
      deliveryId: "delivery-old-runner-report",
    })).resolves.toEqual({ delivered: true });

    expect(injectAtToolBoundary).toHaveBeenCalledOnce();
    expect(intervene).toHaveBeenCalledOnce();
    expect(intervene).toHaveBeenCalledWith(expect.objectContaining({
      inputUuid: expect.any(String),
      prompt: "report during a rolling deployment",
    }));
  });

  it.each(["system", "browser"])(
    "does not interrupt when tool-boundary injection reports no active turn for %s input",
    async (source) => {
      const intervene = vi.fn().mockResolvedValue({
        status: "not_delivered",
        mechanism: "interrupt_then_next_turn",
        reason: "next_turn_required",
      });
      const injectAtToolBoundary = vi.fn().mockResolvedValue({
        status: "not_delivered",
        mechanism: "active_turn",
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
          injectAtToolBoundary,
        } as unknown as EnginePort),
      });
      const transition = new RunningInterventionTransition({
        broadcaster: makeBroadcaster(),
        logger: silentLogger,
        persistence: makeEventPersistenceTestDouble().persistence,
      });

      await expect(transition.deliver(task, {
        text: "report after the active turn ended",
        user: source,
        callerInfo: { source },
        deliveryId: "delivery-no-active-turn",
      })).resolves.toMatchObject({
        delivered: false,
        queued: true,
        reason: "no_active_turn",
      });

      expect(injectAtToolBoundary).toHaveBeenCalledOnce();
      expect(intervene).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "agent", user: "roselin", source: "agent", text: "agent report to Codex" },
    { label: "browser", user: "alice", source: "browser", text: "browser input to Codex" },
  ])("keeps the Codex turn/steer path unchanged for $label input", async ({ user, source, text }) => {
    const intervene = vi.fn().mockResolvedValue({
      status: "delivered",
      mechanism: "active_turn",
    });
    const injectAtToolBoundary = vi.fn();
    const task = makeRunningTask({
      runner: createInProcessTaskRunnerRuntime({
        backendId: "codex",
        workspaceDir: "/tmp/codex",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene,
        injectAtToolBoundary,
      } as unknown as EnginePort),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await expect(transition.deliver(task, {
      text,
      user,
      callerInfo: { source },
    })).resolves.toEqual({ delivered: true });

    expect(intervene).toHaveBeenCalledOnce();
    expect(injectAtToolBoundary).not.toHaveBeenCalled();
  });

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
      undefined,
      "registration:s1",
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
      undefined,
      "registration:s1",
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
      undefined,
      "registration:s1",
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
      undefined,
      "registration:s1",
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
      undefined,
      "registration:s1",
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
      undefined,
      "registration:s1",
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


describe("active intervention assigned cards",()=>{
  it.each(["claude","codex"] as const)("refreshes %s machine input and never publishes snapshot as a reminder event",async backendId=>{
    const intervene=vi.fn().mockResolvedValue({status:"delivered",mechanism:"active_turn"});
    const injectAtToolBoundary=vi.fn().mockResolvedValue({status:"delivered",mechanism:"active_turn"});
    let state="running";
    const assignedCardContext=vi.fn(async()=>({key:"assigned_cards",content:{status:"ok",cards:[{id:"c",status:state}]}}));
    const broadcaster=makeBroadcaster();
    const subject=new RunningInterventionTransition({logger:silentLogger,broadcaster,assignedCardContext,persistence:makeEventPersistenceTestDouble().persistence});
    const task=makeRunningTask({runner:createInProcessTaskRunnerRuntime({backendId,workspaceDir:"/tmp/active",async *execute(){},intervene,injectAtToolBoundary} as never)});
    for(const expected of ["running","review"]){state=expected;await subject.deliver(task,{text:"하위 보고",user:"agent",deliveryId:"active-input-segment",callerInfo:{source:"agent"},context:[{key:"assigned_cards",content:"stale"}]});}
    const calls=backendId==="claude" ? injectAtToolBoundary.mock.calls : intervene.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![0].prompt).toContain('"status": "review"');
    expect(calls[1]![0].prompt).not.toContain("stale");
    expect(calls[1]![0].prompt.match(/<assigned_cards>/g)).toHaveLength(1);
    expect(assignedCardContext).toHaveBeenCalledTimes(2);
    expect(assignedCardContext).toHaveBeenLastCalledWith(task,buildDeliveryInputUuid("active-input-segment"));
    expect(calls[1]![0].inputUuid).toBe(buildDeliveryInputUuid("active-input-segment"));
    expect(task.interventionQueue).toHaveLength(0);
    expect(JSON.stringify((broadcaster.emitEventEnvelope as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('"status":"review"');
  });
  it("sends no assigned_cards block to an active turn when the session has no assigned card", async () => {
    const injectAtToolBoundary=vi.fn().mockResolvedValue({status:"delivered",mechanism:"active_turn"});
    const assignedCardContext=vi.fn(async()=>null);
    const subject=new RunningInterventionTransition({logger:silentLogger,broadcaster:makeBroadcaster(),assignedCardContext,persistence:makeEventPersistenceTestDouble().persistence});
    const task=makeRunningTask({runner:createInProcessTaskRunnerRuntime({backendId:"claude",workspaceDir:"/tmp/active",async *execute(){},intervene:vi.fn(),injectAtToolBoundary} as never)});
    await subject.deliver(task,{text:"하위 보고",user:"agent",deliveryId:"no-card-input",callerInfo:{source:"agent"},context:[{key:"assigned_cards",content:"stale"}]});
    expect(injectAtToolBoundary).toHaveBeenCalledOnce();
    const prompt=injectAtToolBoundary.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("하위 보고");
    expect(prompt).not.toContain("assigned_cards");
    expect(prompt).not.toContain("stale");
  });
});

describe("managed attachment intervention delivery", () => {
  it("waits for acceptance ack and preparation before tool-boundary injection", async () => {
    const order: string[] = [];
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const persistenceDouble = makeEventPersistenceTestDouble();
    persistenceDouble.enqueueEvent.mockImplementation(async () => {
      order.push("acceptance");
      return { source_seq: 1 };
    });
    persistenceDouble.waitForSessionAck.mockImplementation(async () => {
      order.push("ack");
      return 1;
    });
    const prepareAttachmentInput: PrepareAttachmentInput = vi.fn(async (input) => {
      order.push("prepare-start");
      await preparationGate;
      order.push("prepare-complete");
      expect(input).toEqual({
        sessionId: "s1",
        text: "read the attached file",
        attachmentIds: ["att-a"],
        attachmentPaths: ["/tmp/incoming/a.png"],
        attachmentBindings: [
          { attachment_id: "att-a", node_id: "node-1", path: "/tmp/incoming/a.png" },
        ],
        deliveryId: "delivery-a",
      });
      return {
        text: input.text,
        attachmentPaths: ["/tmp/cache/current.png"],
        imageAttachmentPaths: ["/tmp/cache/current.png"],
      };
    });
    const intervene = vi.fn();
    const injectAtToolBoundary = vi.fn(async () => {
      order.push("engine");
      return { status: "delivered" as const, mechanism: "active_turn" as const };
    });
    const register = vi.fn().mockResolvedValue(undefined);
    const task = makeRunningTask({
      activeDeliveryTurnReceipt: { register } as never,
      runner: createInProcessTaskRunnerRuntime({
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene,
        injectAtToolBoundary,
      } as unknown as EnginePort),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
      prepareAttachmentInput,
    });
    const message = makeManagedInterventionMessage();
    const originalMessage = structuredClone(message);
    const delivery = transition.deliver(task, message);

    await vi.waitFor(
      () => expect(prepareAttachmentInput).toHaveBeenCalledOnce(),
      { timeout: 250 },
    );
    expect(order).toEqual(["acceptance", "ack", "prepare-start"]);
    expect(injectAtToolBoundary).not.toHaveBeenCalled();
    expect(intervene).not.toHaveBeenCalled();
    releasePreparation();

    await expect(delivery).resolves.toEqual({ delivered: true });
    expect(order).toEqual(["acceptance", "ack", "prepare-start", "prepare-complete", "engine"]);
    expect(injectAtToolBoundary).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "read the attached file\n\n[첨부 파일 로컬 경로: /tmp/cache/current.png]",
      imageAttachmentPaths: ["/tmp/cache/current.png"],
      inputUuid: buildDeliveryInputUuid("delivery-a"),
    }));
    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "read the attached file",
        attachments: ["/tmp/incoming/a.png"],
        attachment_ids: ["att-a"],
      }),
      undefined,
      "registration:s1",
    );
    expect(register).toHaveBeenCalledWith(originalMessage);
    expect(message).toEqual(originalMessage);
  });

  it("propagates preparation failures without calling the engine or changing original IDs", async () => {
    const prepareAttachmentInput: PrepareAttachmentInput = vi.fn(async () => {
      throw new Error("materializer failed");
    });
    const intervene = vi.fn().mockResolvedValue({ status: "delivered", mechanism: "active_turn" });
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
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
      prepareAttachmentInput,
    });
    const message = makeManagedInterventionMessage();
    const originalMessage = structuredClone(message);

    await expect(transition.deliver(task, message)).rejects.toThrow("materializer failed");

    expect(prepareAttachmentInput).toHaveBeenCalledOnce();
    expect(intervene).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([]);
    expect(message).toEqual(originalMessage);
  });

  it("uses the delivery ID and publishes acceptance only after a deferred live delivery succeeds", async () => {
    const order: string[] = [];
    const persistenceDouble = makeEventPersistenceTestDouble();
    persistenceDouble.enqueueEvent.mockImplementation(async () => {
      order.push("acceptance");
      return { source_seq: 1 };
    });
    const prepareAttachmentInput: PrepareAttachmentInput = vi.fn(async (input) => {
      order.push("prepare");
      expect(input.deliveryId).toBe("delivery-a");
      return {
        text: input.text,
        attachmentPaths: ["/tmp/cache/current.png"],
        imageAttachmentPaths: ["/tmp/cache/current.png"],
      };
    });
    const intervene = vi.fn(async () => {
      order.push("engine");
      return { status: "delivered" as const, mechanism: "active_turn" as const };
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
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
      prepareAttachmentInput,
    });

    await expect(
      transition.deliver(task, makeManagedInterventionMessage(), { queueIfUndelivered: false }),
    ).resolves.toEqual({ delivered: true });

    expect(order).toEqual(["prepare", "engine", "acceptance"]);
    expect(persistenceDouble.waitForSessionAck).not.toHaveBeenCalled();
    expect(intervene).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "read the attached file\n\n[첨부 파일 로컬 경로: /tmp/cache/current.png]",
      imageAttachmentPaths: ["/tmp/cache/current.png"],
    }));
  });

  it("requires a delivery ID before materializing a deferred attachment with no event reference", async () => {
    const persistenceDouble = makeEventPersistenceTestDouble();
    const prepareAttachmentInput: PrepareAttachmentInput = vi.fn(async (input) => ({
      text: input.text,
      attachmentPaths: ["/tmp/cache/current.png"],
      imageAttachmentPaths: ["/tmp/cache/current.png"],
    }));
    const intervene = vi.fn().mockResolvedValue({ status: "delivered", mechanism: "active_turn" });
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
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
      prepareAttachmentInput,
    });
    const message = makeManagedInterventionMessage();
    delete message.deliveryId;

    await expect(
      transition.deliver(task, message, { queueIfUndelivered: false }),
    ).rejects.toThrow("ATTACHMENT_DELIVERY_AUTHORIZATION_REQUIRED");

    expect(prepareAttachmentInput).not.toHaveBeenCalled();
    expect(intervene).not.toHaveBeenCalled();
    expect(persistenceDouble.enqueueEvent).not.toHaveBeenCalled();
  });

  it("does not materialize attachments while queue-only defers them to the next turn", async () => {
    const prepareAttachmentInput: PrepareAttachmentInput = vi.fn(async (input) => ({
      text: input.text,
      attachmentPaths: ["/tmp/cache/current.png"],
      imageAttachmentPaths: ["/tmp/cache/current.png"],
    }));
    const task = makeRunningTask();
    const message = makeManagedInterventionMessage();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
      prepareAttachmentInput,
    });

    await expect(transition.queueOnly(task, message)).resolves.toMatchObject({
      delivered: false,
      queued: true,
      consumeWhen: "next_turn",
    });

    expect(prepareAttachmentInput).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([message]);
  });

  it("fails managed input when the attachment preparation dependency is unavailable", async () => {
    const intervene = vi.fn().mockResolvedValue({ status: "delivered", mechanism: "active_turn" });
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
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
    });

    await expect(transition.deliver(task, makeManagedInterventionMessage()))
      .rejects.toThrow("ATTACHMENT_INPUT_UNAVAILABLE");

    expect(intervene).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([]);
  });

  it("delivers a delayed attachment intervention before a later plain intervention", async () => {
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const engineOrder: string[] = [];
    const prepareAttachmentInput: PrepareAttachmentInput = vi.fn(async (input) => {
      await preparationGate;
      return {
        text: input.text,
        attachmentPaths: ["/tmp/cache/a.png"],
        imageAttachmentPaths: ["/tmp/cache/a.png"],
      };
    });
    const injectAtToolBoundary = vi.fn(async (input: { prompt: string }) => {
      engineOrder.push(input.prompt.includes("/tmp/cache/a.png") ? "A" : "B");
      return { status: "delivered" as const, mechanism: "active_turn" as const };
    });
    const task = makeRunningTask({
      runner: createInProcessTaskRunnerRuntime({
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene: vi.fn(),
        injectAtToolBoundary,
      } as unknown as EnginePort),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
      prepareAttachmentInput,
    });

    const deliveryA = transition.deliver(task, makeManagedInterventionMessage());
    await vi.waitFor(
      () => expect(prepareAttachmentInput).toHaveBeenCalledOnce(),
      { timeout: 250 },
    );
    const deliveryB = transition.deliver(task, {
      text: "plain intervention B",
      user: "worker",
      callerInfo: { source: "agent", agent_id: "worker" },
      deliveryId: "delivery-b",
    }, { queueIfUndelivered: false });

    expect(injectAtToolBoundary).not.toHaveBeenCalled();
    releasePreparation();
    await expect(Promise.all([deliveryA, deliveryB])).resolves.toEqual([
      { delivered: true },
      { delivered: true },
    ]);
    expect(engineOrder).toEqual(["A", "B"]);
  });

  it("continues with the next intervention when preparation fails", async () => {
    let rejectPreparation!: (error: Error) => void;
    const preparationGate = new Promise<void>((_resolve, reject) => {
      rejectPreparation = reject;
    });
    const engineOrder: string[] = [];
    const prepareAttachmentInput: PrepareAttachmentInput = vi.fn(async () => {
      await preparationGate;
      return { text: "unreachable", attachmentPaths: [], imageAttachmentPaths: [] };
    });
    const intervene = vi.fn(async (input: { prompt: string }) => {
      engineOrder.push(input.prompt);
      return { status: "delivered" as const, mechanism: "active_turn" as const };
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
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
      prepareAttachmentInput,
    });

    const deliveryA = transition.deliver(task, makeManagedInterventionMessage());
    await vi.waitFor(
      () => expect(prepareAttachmentInput).toHaveBeenCalledOnce(),
      { timeout: 250 },
    );
    const failedA = expect(deliveryA).rejects.toThrow("materialize A failed");
    const deliveryB = transition.deliver(task, {
      text: "plain intervention B",
      user: "worker",
      callerInfo: { source: "agent", agent_id: "worker" },
      deliveryId: "delivery-b",
    }, { queueIfUndelivered: false });

    expect(intervene).not.toHaveBeenCalled();
    rejectPreparation(new Error("materialize A failed"));
    await failedA;
    await expect(deliveryB).resolves.toEqual({ delivered: true });
    expect(intervene).toHaveBeenCalledOnce();
    expect(engineOrder).toHaveLength(1);
    expect(engineOrder[0]).toContain("plain intervention B");
  });

  it("keeps two attachment interventions in order with their own prepared paths", async () => {
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const preparedIds: string[] = [];
    const prepareAttachmentInput: PrepareAttachmentInput = vi.fn(async (input) => {
      const attachmentId = input.attachmentIds?.[0];
      preparedIds.push(attachmentId ?? "missing");
      if (attachmentId === "att-a") await preparationGate;
      const path = `/tmp/cache/${attachmentId}.png`;
      return {
        text: input.text,
        attachmentPaths: [path],
        imageAttachmentPaths: [path],
      };
    });
    const engineInputs: Array<{ prompt: string; paths?: string[] }> = [];
    const intervene = vi.fn(async (input: { prompt: string; imageAttachmentPaths?: string[] }) => {
      engineInputs.push({ prompt: input.prompt, paths: input.imageAttachmentPaths });
      return { status: "delivered" as const, mechanism: "active_turn" as const };
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
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
      prepareAttachmentInput,
    });
    const messageA = makeManagedInterventionMessage();
    const messageB: InterventionMessage = {
      ...makeManagedInterventionMessage(),
      text: "read attachment B",
      attachmentPaths: ["/tmp/incoming/b.png"],
      attachmentIds: ["att-b"],
      attachmentBindings: [
        { attachment_id: "att-b", node_id: "node-1", path: "/tmp/incoming/b.png" },
      ],
      deliveryId: "delivery-b",
    };

    const deliveryA = transition.deliver(task, messageA);
    await vi.waitFor(
      () => expect(prepareAttachmentInput).toHaveBeenCalledOnce(),
      { timeout: 250 },
    );
    const deliveryB = transition.deliver(task, messageB);

    expect(preparedIds).toEqual(["att-a"]);
    releasePreparation();
    await expect(Promise.all([deliveryA, deliveryB])).resolves.toEqual([
      { delivered: true },
      { delivered: true },
    ]);
    expect(preparedIds).toEqual(["att-a", "att-b"]);
    expect(engineInputs).toHaveLength(2);
    expect(engineInputs[0]?.prompt).toContain("/tmp/cache/att-a.png");
    expect(engineInputs[0]?.paths).toEqual(["/tmp/cache/att-a.png"]);
    expect(engineInputs[1]?.prompt).toContain("/tmp/cache/att-b.png");
    expect(engineInputs[1]?.paths).toEqual(["/tmp/cache/att-b.png"]);
  });

  it("delivers the next intervention without waiting for the prior turn to finish", async () => {
    let finishTurn!: () => void;
    let turnFinished = false;
    const priorTurn = new Promise<boolean>((resolve) => {
      finishTurn = () => {
        turnFinished = true;
        resolve(false);
      };
    });
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const engineOrder: string[] = [];
    const prepareAttachmentInput: PrepareAttachmentInput = vi.fn(async (input) => {
      await preparationGate;
      return {
        text: input.text,
        attachmentPaths: ["/tmp/cache/a.png"],
        imageAttachmentPaths: ["/tmp/cache/a.png"],
      };
    });
    const injectAtToolBoundary = vi.fn(async (input: { prompt: string }) => {
      engineOrder.push(input.prompt.includes("/tmp/cache/a.png") ? "A" : "B");
      return { status: "delivered" as const, mechanism: "active_turn" as const };
    });
    const task = makeRunningTask({
      interruptRequest: priorTurn,
      runner: createInProcessTaskRunnerRuntime({
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        intervene: vi.fn(),
        injectAtToolBoundary,
      } as unknown as EnginePort),
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble().persistence,
      prepareAttachmentInput,
    });

    const deliveryA = transition.deliver(task, makeManagedInterventionMessage());
    await vi.waitFor(
      () => expect(prepareAttachmentInput).toHaveBeenCalledOnce(),
      { timeout: 250 },
    );
    const deliveryB = transition.deliver(task, {
      text: "plain intervention B",
      user: "worker",
      callerInfo: { source: "agent", agent_id: "worker" },
      deliveryId: "delivery-b",
    }, { queueIfUndelivered: false });
    const deliveries = Promise.all([deliveryA, deliveryB]);

    releasePreparation();
    try {
      await vi.waitFor(
        () => expect(engineOrder).toEqual(["A", "B"]),
        { timeout: 250 },
      );
      expect(turnFinished).toBe(false);
    } finally {
      finishTurn();
    }
    await expect(deliveries).resolves.toEqual([
      { delivered: true },
      { delivered: true },
    ]);
    await priorTurn;
    expect(turnFinished).toBe(true);
  });
});
