import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { attachClaudeBackgroundDeliveryMetadata } from "../../src/engine/claude_background_delivery_metadata.js";
import { attachClaudeBackgroundProvenance } from "../../src/engine/claude_background_provenance.js";
import { markPostResultDrainEvent } from "../../src/engine/claude_event_phase.js";
import { attachClaudeResultReceiptMetadata } from
  "../../src/engine/claude_result_receipt_metadata.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { buildClaudeBackgroundGenerationIdentity } from "../../src/task/claude_background_generation_identity.js";
import {
  CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
  ClaudeRuntimeTaskFollowupController,
  type ClaudeRuntimeTaskFollowupPort,
} from "../../src/task/claude_runtime_task_followup.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskDeliveryLedgerGate } from "../../src/task/task_delivery_ledger_gate.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

const claudeAgent: AgentProfile = {
  id: "claude-roselin",
  name: "로젤린",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
};

function makeTask(): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: claudeAgent.id,
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function exactResult(inputUuid: string | undefined): SSEEventPayload {
  if (!inputUuid) throw new Error("exact Result input UUID is required");
  const event = {
    type: "result",
    success: true,
    output: "runtime follow-up consumed",
  } as SSEEventPayload;
  attachClaudeResultReceiptMetadata(event, { inputUuid });
  return event;
}

function makeMocks() {
  const persistenceDouble = makeEventPersistenceTestDouble(
    async (_sessionId: string, event: SSEEventPayload, task: Task) => {
      if (event.type === "text_delta" && typeof event.text === "string") {
        task.lastAssistantText = event.text;
      }
      if (event.type === "assistant_message" && typeof event.content === "string") {
        task.lastAssistantText = event.content;
      }
    },
  );
  const { persistence } = persistenceDouble;

  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;

  return {
    persistence,
    enqueueEvent: persistenceDouble.enqueueEvent,
    enqueueEventAndWaitForSessionAck:
      persistenceDouble.enqueueEventAndWaitForSessionAck,
    enqueueTerminalTransitionAndWaitForApplication:
      persistenceDouble.enqueueTerminalTransitionAndWaitForApplication,
    db,
    broadcaster,
  };
}

describe("TaskExecutor Claude runtime task follow-up", () => {
  it.each(["foreground", "result-before-terminal", "error", "sdk-membership"] as const)(
    "SendMessage %s reaches the ledger at turn end", async (scenario) => {
      const mocks = makeMocks();
      const task = makeTask();
      task.codexThreadId = "sdk-session-1";
      task.claudeRuntime = { updatedAt: 1, tasks: { child: {
        taskId: "child", status: "running", updatedAt: 1,
        ...(scenario === "sdk-membership" ? {} : { isBackgrounded: true }), toolUseId: "send-1",
      } } };
      let tombstone: { relationKey: string; completionId: string } | undefined;
      let row: Record<string, unknown> | undefined;
      const repository = {
        recordRelationConsumed: vi.fn(async (relation) => { tombstone = relation; return {}; }),
        get: vi.fn(async () => row ?? null),
        register: vi.fn(async (params) => {
          const consumed = tombstone?.relationKey === params.relationKey && tombstone?.completionId === params.completionId;
          row = { delivery_id: params.deliveryId, relation_key: params.relationKey,
            completion_id: params.completionId, intent: params.intent, target_session_id: params.targetSessionId,
            payload: params.payload, payload_hash: params.payloadHash, created_at: params.createdAt ?? new Date(),
            state: consumed ? "consumed" : "pending", aggregate_state: consumed ? "consumed" : "pending" };
          return { row, inserted: true, conflict: false };
        }),
        claimAttemptForTarget: vi.fn(async (_id, _target, token) => {
          row = { ...row, state: "claimed", attempt_token: token };
          return row;
        }),
      };
      const gate = new TaskDeliveryLedgerGate(true, repository as never, { resolveGeneration: vi.fn() } as never, "node-1");
      const resume = vi.fn();
      const queue = vi.fn(async (_task, message) => {
        task.interventionQueue.push(message);
        return { delivered: false as const, queued: true as const, queuePosition: 1, consumeWhen: "next_turn" as const, reason: "queue_only_policy" as const };
      });
      const route = new TaskInterventionRoute({
        getTask: () => task, loadEvictedTask: async () => null, rememberTask: () => {},
        runningInterventionTransition: { deliver: queue, queueOnly: queue },
        autoResumeTransition: { resume: vi.fn() } as never,
        deliveryLedgerGate: {
          admit: gate.admit.bind(gate), beginDispatch: async (admission) => admission,
          recordResult: async () => {}, deferFailureToCoordinator: async () => {},
          recordNotificationPublished: async () => {}, recordNotificationFailure: async () => {},
        },
      });
      const controller = new ClaudeRuntimeTaskFollowupController({
        taskManager: { addIntervention: (params, onResume) => route.addIntervention(params, onResume) },
        onResume: resume, releaseRetainedRunner: async () => undefined,
        logger: silentLogger, deliveryV2Enabled: true, sourceNode: "node-1",
      });
      const collect = vi.spyOn(controller, "collect");
      let turns = 0;
      const engine: EnginePort = {
        backendId: "claude", workspaceDir: "/tmp/claude-roselin",
        async *execute(params) {
          turns++;
          if (turns === 1) {
            yield { type: "tool_start", tool_name: "SendMessage", tool_use_id: "send-1", tool_input: {}, timestamp: 1 } as SSEEventPayload;
            const result = { type: "tool_result", tool_name: "SendMessage", tool_use_id: "send-1", is_error: scenario === "error", result: "report", timestamp: 2 } as SSEEventPayload;
            if (scenario === "result-before-terminal") yield result;
            task.claudeRuntime!.tasks.child!.status = "completed";
            const terminal = { type: "claude_runtime_task_updated", task_id: "child", session_id: "sdk-session-1", patch: { status: "completed", ...(scenario === "sdk-membership" ? {} : { is_backgrounded: true }), tool_use_id: "send-1" } } as unknown as SSEEventPayload;
            if (scenario === "sdk-membership") {
              const identity = buildClaudeBackgroundGenerationIdentity({
                sourceNode: "node-1", agentSessionId: task.agentSessionId,
                sdkSessionId: "sdk-session-1", sdkTaskId: "child", initiatingToolUseId: "send-1",
              });
              attachClaudeBackgroundProvenance(terminal, "sdk_membership");
              attachClaudeBackgroundDeliveryMetadata(terminal, {
                initiatingToolUseId: "send-1", deliveryId: identity.deliveryId,
                completionId: identity.completionId, relationKey: identity.relationKey,
                producerTerminalRevision: "1", deliveryCreatedAt: "2026-11-18T00:00:00.000Z",
                source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
                storedPayload: { text: "done", user: "system" }, storedPayloadHash: "hash",
              });
            }
            yield terminal;
            if (scenario !== "result-before-terminal") yield result;
          } else {
            yield exactResult(params.inputUuid);
          }
          yield { type: "complete", result: "done", timestamp: 3 } as SSEEventPayload;
        },
        async intervene() { return { status: "not_delivered", mechanism: "interrupt_then_next_turn", reason: "next_turn_required" }; },
        async interrupt() { return true; }, async close() {},
      };
      const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger,
        undefined, undefined, undefined, controller, {
          recordTurnStarted: vi.fn(async () => {}), recordConsumed: vi.fn(async () => {}),
          discardIfConsumed: vi.fn(async () => false),
          recordConsumptionFailure: vi.fn(async () => {}), recordAdmissionFailure: vi.fn(async () => {}),
          recordRuntimeFollowupRelationConsumed: gate.recordRuntimeFollowupRelationConsumed.bind(gate),
        });
      executor.startNewExecution(task, claudeAgent);
      await task.executionPromise;
      const consumed = scenario === "foreground" || scenario === "sdk-membership";
      expect(turns).toBe(consumed ? 1 : 2);
      expect(repository.recordRelationConsumed).toHaveBeenCalledTimes(consumed ? 1 : 0);
      expect(queue).toHaveBeenCalledTimes(consumed ? 0 : 1);
      if (scenario === "sdk-membership") expect(collect).toHaveReturnedWith(expect.any(String));
      expect(resume).not.toHaveBeenCalled();
    },
  );

  it("background runtime notification flush 후 다음 turn을 자동 시작한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    let flushCalls = 0;
    const followup: ClaudeRuntimeTaskFollowupPort = {
      collect: vi.fn(),
      flush: vi.fn(async (target) => {
        if (flushCalls > 0) return;
        flushCalls += 1;
        target.interventionQueue.push({
          text: "runtime follow-up prompt",
          user: "system",
          source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
          followupAttempt: 1,
          followupKey: "sess-1:task-1",
        });
      }),
      collectDetached: vi.fn(),
    };
    const capturedPrompts: string[] = [];
    const capturedOrigins: Array<unknown> = [];
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedPrompts.push(params.prompt);
        capturedOrigins.push(params.turnOrigin);
        if (turnCount === 0) {
          turnCount += 1;
          yield {
            type: "claude_runtime_task_notification",
            task_id: "task-1",
            status: "completed",
          } as SSEEventPayload;
          yield { type: "complete", result: "first", timestamp: 1 } as SSEEventPayload;
          return;
        }
        turnCount += 1;
        yield {
          type: "assistant_message",
          content: "continued after runtime task",
          timestamp: 2,
        } as SSEEventPayload;
        yield { type: "complete", result: "second", timestamp: 2 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      followup,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turnCount).toBe(2);
    expect(capturedPrompts).toEqual(["hi", "runtime follow-up prompt"]);
    expect(capturedOrigins).toEqual([
      { kind: "initial_prompt" },
      { kind: "runtime_followup" },
    ]);
    expect(followup.collect).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ type: "claude_runtime_task_notification", task_id: "task-1" }),
    );
    expect(task.status).toBe("completed");
  });

  it("killed background task follow-up을 소비한 빈 turn은 단 한 번 전달되고 세션을 살려 둔다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.codexThreadId = "sdk-session-1";
    task.claudeRuntime = {
      sessionState: "idle",
      updatedAt: Date.now(),
      tasks: {
        watcher: {
          taskId: "watcher",
          status: "running",
          updatedAt: 1,
          isBackgrounded: true,
          toolUseId: "toolu-watcher",
        },
      },
    };
    const addIntervention = vi.fn(async (message) => {
      task.interventionQueue.push(message);
      return { queued: true as const, queuePosition: 1 };
    });
    const controller = new ClaudeRuntimeTaskFollowupController({
      taskManager: { addIntervention },
      onResume: vi.fn(),
      releaseRetainedRunner: async () => undefined,
      logger: silentLogger,
      deliveryV2Enabled: true,
      sourceNode: "node-1",
    });
    const deliveryRecorder = {
      recordTurnStarted: vi.fn(async () => undefined),
      recordConsumed: vi.fn(async () => undefined),
    };
    const prompts: string[] = [];
    let turnCount = 0;
    const interrupt = vi.fn(async () => true);
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        prompts.push(params.prompt);
        turnCount += 1;
        if (turnCount === 1) {
          task.claudeRuntime!.tasks.watcher!.status = "killed";
          yield {
            type: "claude_runtime_task_notification",
            task_id: "watcher",
            status: "killed",
            _event_id: 77,
            session_id: "sdk-session-1",
            tool_use_id: "toolu-watcher",
          } as SSEEventPayload;
          yield {
            type: "complete",
            result: "foreground complete",
            timestamp: 1,
          } as SSEEventPayload;
          return;
        }
        yield exactResult(params.inputUuid);
        yield { type: "complete", result: "", timestamp: 2 } as SSEEventPayload;
      },
      interrupt,
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      controller,
      deliveryRecorder,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("task_id=watcher");
    expect(prompts[1]).toContain("status=killed");
    expect(addIntervention).toHaveBeenCalledTimes(1);
    expect(deliveryRecorder.recordTurnStarted).toHaveBeenCalledTimes(1);
    expect(deliveryRecorder.recordConsumed).toHaveBeenCalledTimes(1);
    expect(interrupt).not.toHaveBeenCalled();
    expect(task.status).toBe("completed");
    expect(mocks.enqueueEvent.mock.calls.find(
      (call) =>
        (call[1] as { error_code?: string }).error_code ===
          "claude_runtime_followup_stalled",
    )).toBeUndefined();
  });

  it("소비된 빈 runtime follow-up은 뒤따른 사용자 turn을 간섭하지 않는다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    let flushed = false;
    const followup: ClaudeRuntimeTaskFollowupPort = {
      collect: vi.fn(),
      collectDetached: vi.fn(),
      flush: vi.fn(async (target) => {
        if (flushed) return;
        flushed = true;
        target.interventionQueue.push({
          text: "runtime follow-up prompt",
          user: "system",
          source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
          deliveryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          deliveryIntent: "runtime_followup",
        });
      }),
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn(async () => undefined),
      recordConsumed: vi.fn(async () => undefined),
    };
    const prompts: string[] = [];
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        prompts.push(params.prompt);
        turnCount += 1;
        if (turnCount === 1) {
          yield { type: "complete", result: "initial", timestamp: 1 } as SSEEventPayload;
          return;
        }
        if (turnCount === 2) {
          task.interventionQueue.push({ text: "?", user: "alice" });
          yield exactResult(params.inputUuid);
          yield { type: "complete", result: "", timestamp: 2 } as SSEEventPayload;
          return;
        }
        yield {
          type: "assistant_message",
          content: "answered user turn",
          timestamp: 3,
        } as SSEEventPayload;
        yield { type: "complete", result: "answered", timestamp: 3 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      followup,
      deliveryRecorder,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(prompts).toEqual(["hi", "runtime follow-up prompt", "?"]);
    expect(task.lastAssistantText).toBe("answered user turn");
    expect(task.status).toBe("completed");
    expect(mocks.enqueueEvent.mock.calls.find(
      (call) =>
        (call[1] as { error_code?: string }).error_code ===
          "claude_runtime_followup_stalled",
    )).toBeUndefined();
  });

  it("receipt 없는 runtime follow-up은 같은 exact delivery를 1회 재전달해 소비한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    const parent = {
      text: "runtime follow-up prompt",
      user: "system",
      source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
      followupAttempt: 1,
      followupKey: "sess-1:task-lost",
      deliveryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deliveryIntent: "runtime_followup" as const,
    };
    task.interventionQueue.push(parent);
    const followup: ClaudeRuntimeTaskFollowupPort = {
      collect: vi.fn(),
      collectDetached: vi.fn(),
      flush: vi.fn(),
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn(async () => undefined),
      recordConsumed: vi.fn(async () => undefined),
    };
    const deliveredInputUuids: Array<string | undefined> = [];
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        deliveredInputUuids.push(params.inputUuid);
        turnCount += 1;
        if (turnCount === 1) return;
        yield exactResult(params.inputUuid);
        yield { type: "complete", result: "", timestamp: 2 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      followup,
      deliveryRecorder,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turnCount).toBe(2);
    expect(deliveredInputUuids[0]).toBe(
      buildDeliveryInputUuid(parent.deliveryId),
    );
    expect(deliveredInputUuids[1]).toBe(deliveredInputUuids[0]);
    expect(deliveryRecorder.recordTurnStarted).toHaveBeenCalledTimes(1);
    expect(deliveryRecorder.recordConsumed).toHaveBeenCalledTimes(1);
    expect(task.interventionQueue).toEqual([]);
    expect(task.status).toBe("completed");
  });

  it("receipt가 계속 없으면 같은 exact delivery 재전달을 1회로 제한한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.interventionQueue.push({
      text: "runtime follow-up prompt",
      user: "system",
      source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
      deliveryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      deliveryIntent: "runtime_followup",
      followupKey: "sess-1:task-still-lost",
    });
    const followup: ClaudeRuntimeTaskFollowupPort = {
      collect: vi.fn(),
      collectDetached: vi.fn(),
      flush: vi.fn(),
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn(async () => undefined),
      recordConsumed: vi.fn(async () => undefined),
    };
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        turnCount += 1;
        return;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      followup,
      deliveryRecorder,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turnCount).toBe(2);
    expect(deliveryRecorder.recordTurnStarted).not.toHaveBeenCalled();
    expect(deliveryRecorder.recordConsumed).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([]);
    expect(task.status).toBe("completed");
  });

  it("exact delivery 재전달은 동시에 들어온 사용자 turn과 분리한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.interventionQueue.push({
      text: "runtime follow-up prompt",
      user: "system",
      source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
      deliveryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      deliveryIntent: "runtime_followup",
      followupKey: "sess-1:task-lost-with-user",
    });
    const followup: ClaudeRuntimeTaskFollowupPort = {
      collect: vi.fn(),
      collectDetached: vi.fn(),
      flush: vi.fn(),
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn(async () => undefined),
      recordConsumed: vi.fn(async () => undefined),
    };
    const prompts: string[] = [];
    const deliveredInputUuids: Array<string | undefined> = [];
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        prompts.push(params.prompt);
        deliveredInputUuids.push(params.inputUuid);
        turnCount += 1;
        if (turnCount === 1) {
          task.interventionQueue.push({
            text: "?",
            user: "alice",
            deliveryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          });
          return;
        }
        if (params.prompt === "runtime follow-up prompt" && turnCount > 1) {
          yield exactResult(params.inputUuid);
        }
        yield { type: "complete", result: "", timestamp: turnCount } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      followup,
      deliveryRecorder,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turnCount).toBe(3);
    expect(prompts).toEqual([
      "runtime follow-up prompt",
      "?",
      "runtime follow-up prompt",
    ]);
    expect(deliveredInputUuids[2]).toBe(deliveredInputUuids[0]);
    expect(deliveredInputUuids[1]).not.toBe(deliveredInputUuids[0]);
    expect(deliveryRecorder.recordTurnStarted).toHaveBeenCalledTimes(2);
    expect(deliveryRecorder.recordConsumed).toHaveBeenCalledTimes(2);
    expect(task.status).toBe("completed");
  });

  it("runtime exact proof가 없으면 user turn과 분리해 한 번만 replay한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    const followup: ClaudeRuntimeTaskFollowupPort = {
      collect: vi.fn(),
      collectDetached: vi.fn(),
      flush: vi.fn(),
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn(async () => undefined),
      recordConsumed: vi.fn(async () => undefined),
    };
    const prompts: string[] = [];
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        prompts.push(params.prompt);
        turnCount += 1;
        if (turnCount === 1) {
          task.interventionQueue.push(
            {
              text: "runtime follow-up prompt",
              user: "system",
              source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
              deliveryId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              deliveryIntent: "runtime_followup",
            },
            {
              text: "?",
              user: "alice",
              deliveryId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            },
          );
        }
        yield { type: "complete", result: "", timestamp: turnCount } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      followup,
      deliveryRecorder,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turnCount).toBe(4);
    expect(prompts).toEqual([
      "hi",
      "?",
      "runtime follow-up prompt",
      "runtime follow-up prompt",
    ]);
    expect(deliveryRecorder.recordTurnStarted).toHaveBeenCalledTimes(1);
    expect(deliveryRecorder.recordConsumed).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("completed");
  });

  it("interrupt로 종료된 turn은 runtime follow-up보다 finalizer를 먼저 완료한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
    const controller = new ClaudeRuntimeTaskFollowupController({
      taskManager: { addIntervention },
      onResume: vi.fn(),
      releaseRetainedRunner: async () => undefined,
      logger: silentLogger,
      sourceNode: "node-1",
    });
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        yield {
          type: "claude_runtime_task_notification",
          task_id: "task-interrupted",
          status: "completed",
          summary: "completed before interrupt finalization",
        } as SSEEventPayload;
        task.status = "interrupted";
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      controller,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(addIntervention).not.toHaveBeenCalled();
    expect(task.status).toBe("interrupted");
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended", status: "interrupted" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "interrupted",
      }),
      expect.stringMatching(/^in-process:/),
    );
  });

  it("notification과 terminal task_updated를 같은 follow-up prompt에 반영한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.codexThreadId = "sdk-session-1";
    let addInterventionCalls = 0;
    const controller = new ClaudeRuntimeTaskFollowupController({
      taskManager: {
        addIntervention: vi.fn(async (params) => {
          addInterventionCalls += 1;
          task.interventionQueue.push({
            text: params.text,
            user: params.user,
            source: params.source,
            followupAttempt: params.followupAttempt,
            followupKey: params.followupKey,
          });
          return { queued: true, queuePosition: addInterventionCalls };
        }),
      },
      onResume: vi.fn(),
      releaseRetainedRunner: async () => undefined,
      logger: silentLogger,
      sourceNode: "node-1",
    });
    const prompts: string[] = [];
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        prompts.push(params.prompt);
        if (turnCount === 0) {
          turnCount += 1;
          yield {
            type: "claude_runtime_task_updated",
            task_id: "task-a",
            patch: {
              status: "completed",
              is_backgrounded: true,
              output_file: "/tmp/a.output",
              tool_use_id: "toolu-task-a",
            },
            session_id: "sdk-session-1",
          } as unknown as SSEEventPayload;
          yield {
            type: "claude_runtime_task_updated",
            task_id: "task-b",
            patch: {
              status: "running",
              is_backgrounded: true,
              tool_use_id: "toolu-task-b",
            },
            session_id: "sdk-session-1",
          } as unknown as SSEEventPayload;
          yield {
            type: "claude_runtime_task_notification",
            task_id: "task-b",
            status: "completed",
            summary: "second task done",
            session_id: "sdk-session-1",
            tool_use_id: "toolu-task-b",
          } as SSEEventPayload;
          yield { type: "complete", result: "first", timestamp: 1 } as SSEEventPayload;
          return;
        }
        turnCount += 1;
        yield { type: "assistant_message", content: "continued", timestamp: 2 } as SSEEventPayload;
        yield { type: "complete", result: "second", timestamp: 2 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      controller,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(addInterventionCalls).toBe(2);
    expect(turnCount).toBe(3);
    expect(prompts[1]).toContain("task-a");
    expect(prompts[1]).toContain("/tmp/a.output");
    expect(prompts[2]).toContain("task-b");
    expect(prompts[2]).toContain("second task done");
  });

  it.each(["before", "after", "same_tick"] as const)(
    "동기 local_agent notification이 foreground result %s에 도착해도 follow-up하지 않는다",
    async (order) => {
      const mocks = makeMocks();
      const task = makeTask();
      let addInterventionCalls = 0;
      const controller = new ClaudeRuntimeTaskFollowupController({
        taskManager: {
          addIntervention: vi.fn(async (params) => {
            addInterventionCalls += 1;
            task.interventionQueue.push({
              text: params.text,
              user: params.user,
              source: params.source,
              followupAttempt: params.followupAttempt,
              followupKey: params.followupKey,
              followupTaskIds: params.followupTaskIds,
            });
            return { queued: true, queuePosition: addInterventionCalls };
          }),
        },
        onResume: vi.fn(),
        releaseRetainedRunner: async () => undefined,
        logger: silentLogger,
        sourceNode: "node-1",
      });
      const prompts: string[] = [];
      let turnCount = 0;
      const notification = {
        type: "claude_runtime_task_notification",
        task_id: "agent-task",
        status: "stopped",
        summary: "PR diff review",
        output_file: "",
      } as SSEEventPayload;
      const foregroundResult = {
        type: "complete",
        result: "foreground done",
        timestamp: 1,
      } as SSEEventPayload;
      const engine: EnginePort = {
        backendId: "claude",
        workspaceDir: "/tmp/claude-roselin",
        async *execute(params): AsyncIterable<SSEEventPayload> {
          prompts.push(params.prompt);
          if (turnCount === 0) {
            turnCount += 1;
            yield {
              type: "claude_runtime_task_started",
              task_id: "agent-task",
              task_type: "local_agent",
              description: "PR diff review",
            } as SSEEventPayload;
            if (order === "after") {
              yield foregroundResult;
              yield notification;
            } else if (order === "same_tick") {
              yield notification;
              await Promise.resolve();
              yield foregroundResult;
            } else {
              yield notification;
              yield foregroundResult;
            }
            return;
          }
          turnCount += 1;
          yield {
            type: "assistant_message",
            content: "review resumed from terminal notification",
            timestamp: 2,
          } as SSEEventPayload;
          yield { type: "complete", result: "continued", timestamp: 2 } as SSEEventPayload;
        },
        async interrupt() { return true; },
        async close() {},
      };
      const executor = new TaskExecutor(
        () => engine,
        mocks.db,
        mocks.persistence,
        mocks.broadcaster,
        silentLogger,
        undefined,
        undefined,
        undefined,
        controller,
      );

      executor.startNewExecution(task, claudeAgent);
      await task.executionPromise;

      expect(addInterventionCalls).toBe(0);
      expect(turnCount).toBe(1);
      expect(prompts).toEqual(["hi"]);
    },
  );

  it("소비된 runtime follow-up은 attempt 3의 빈 응답이어도 fatal로 격상하지 않는다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    let flushCalls = 0;
    const followup: ClaudeRuntimeTaskFollowupPort = {
      collect: vi.fn(),
      collectDetached: vi.fn(),
      flush: vi.fn(async (target) => {
        if (flushCalls > 0) return;
        flushCalls += 1;
        target.interventionQueue.push({
          text: "runtime follow-up final retry",
          user: "system",
          source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
          followupAttempt: 3,
          followupKey: "sess-1:task-1",
          deliveryId: "99999999-9999-4999-8999-999999999999",
          deliveryIntent: "runtime_followup",
        });
      }),
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn(async () => undefined),
      recordConsumed: vi.fn(async () => undefined),
    };
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        if (turnCount === 0) {
          turnCount += 1;
          yield { type: "assistant_message", content: "previous response", timestamp: 1 } as SSEEventPayload;
          yield { type: "complete", result: "first", timestamp: 1 } as SSEEventPayload;
          return;
        }
        turnCount += 1;
        yield exactResult(params.inputUuid);
        yield { type: "assistant_message", content: "previous response", timestamp: 2 } as SSEEventPayload;
        yield { type: "complete", result: "repeated", timestamp: 2 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      followup,
      deliveryRecorder,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(deliveryRecorder.recordTurnStarted).toHaveBeenCalledTimes(1);
    expect(deliveryRecorder.recordConsumed).toHaveBeenCalledTimes(1);
    const errorPersist = mocks.enqueueEvent.mock.calls.find(
      (call) =>
        (call[1] as { type: string }).type === "error" &&
        (call[1] as { error_code?: string }).error_code ===
          "claude_runtime_followup_stalled",
    );
    expect(errorPersist).toBeUndefined();
    expect(task.status).toBe("completed");
    expect(task.error).toBeUndefined();
  });

  it("detached 배달이 turn-end flush에 재진입해도 같은 delivery를 다시 stage하거나 거짓 error를 내지 않는다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.codexThreadId = "sdk-session-1";
    task.claudeRuntime = {
      sessionState: "idle",
      updatedAt: Date.now(),
      tasks: {
        "task-reentrant": {
          taskId: "task-reentrant",
          status: "completed",
          updatedAt: 77,
          isBackgrounded: true,
          toolUseId: "toolu-reentrant",
        },
      },
    };
    const event = markPostResultDrainEvent({
      type: "claude_runtime_task_notification",
      task_id: "task-reentrant",
      status: "completed",
      _event_id: 77,
      session_id: "sdk-session-1",
      tool_use_id: "toolu-reentrant",
    } as SSEEventPayload);
    let controller!: ClaudeRuntimeTaskFollowupController;
    let reentered = false;
    const addIntervention = vi.fn(async () => {
      if (!reentered) {
        reentered = true;
        await controller.collectDetached(task, event);
      } else {
        throw new Error(
          "Delivery delivery-reentrant could not stage notification",
        );
      }
      return { queued: true as const, queuePosition: 1 };
    });
    controller = new ClaudeRuntimeTaskFollowupController({
      taskManager: { addIntervention },
      onResume: vi.fn(),
      releaseRetainedRunner: vi.fn(async () => undefined),
      logger: silentLogger,
      deliveryV2Enabled: true,
      sourceNode: "node-1",
    });
    const followup: ClaudeRuntimeTaskFollowupPort = {
      collect: vi.fn(),
      collectDetached: (target, payload) =>
        controller.collectDetached(target, payload),
      flush: async (target) => {
        controller.collect(target, event);
        await controller.flush(target);
      },
    };
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        yield { type: "text_delta", text: "foreground done" } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      followup,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(addIntervention).toHaveBeenCalledOnce();
    const falseError = mocks.enqueueEvent.mock.calls.find(
      (call) =>
        (call[1] as { type: string }).type === "error" &&
        (call[1] as { error_code?: string }).error_code ===
          "claude_runtime_followup_enqueue_failed",
    );
    expect(falseError).toBeUndefined();
  });

  it("flush가 follow-up을 큐잉하지 못하면 사용자 가시 nonfatal error를 남긴다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    const followup: ClaudeRuntimeTaskFollowupPort = {
      collect: vi.fn(),
      collectDetached: vi.fn(),
      flush: vi.fn(async () => {
        throw new Error("route unavailable");
      }),
    };
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        yield { type: "complete", result: "first", timestamp: 1 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      followup,
    );

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    const errorPersist = mocks.enqueueEvent.mock.calls.find(
      (call) =>
        (call[1] as { type: string }).type === "error" &&
        (call[1] as { error_code?: string }).error_code ===
          "claude_runtime_followup_enqueue_failed",
    );
    expect(errorPersist?.[1]).toMatchObject({
      type: "error",
      fatal: false,
      error_code: "claude_runtime_followup_enqueue_failed",
    });
    expect(task.status).toBe("completed");
  });
});
