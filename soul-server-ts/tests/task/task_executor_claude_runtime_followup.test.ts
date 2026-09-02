import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import {
  CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
  ClaudeRuntimeTaskFollowupController,
  type ClaudeRuntimeTaskFollowupPort,
} from "../../src/task/claude_runtime_task_followup.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
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

    executor.startExecution(task, claudeAgent);
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
    task.claudeRuntime = {
      sessionState: "idle",
      updatedAt: Date.now(),
      tasks: {
        watcher: {
          taskId: "watcher",
          status: "running",
          updatedAt: 1,
          isBackgrounded: true,
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
          } as SSEEventPayload;
          yield {
            type: "complete",
            result: "foreground complete",
            timestamp: 1,
          } as SSEEventPayload;
          return;
        }
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

    executor.startExecution(task, claudeAgent);
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

    executor.startExecution(task, claudeAgent);
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

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turnCount).toBe(2);
    expect(deliveredInputUuids[0]).toBeDefined();
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

    executor.startExecution(task, claudeAgent);
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

    executor.startExecution(task, claudeAgent);
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

  it("exact replay가 없으면 high와 low intervention을 기존 한 turn에 합친다", async () => {
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

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turnCount).toBe(2);
    expect(prompts).toEqual(["hi", "?\n\nruntime follow-up prompt"]);
    expect(deliveryRecorder.recordTurnStarted).toHaveBeenCalledTimes(2);
    expect(deliveryRecorder.recordConsumed).toHaveBeenCalledTimes(2);
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

    executor.startExecution(task, claudeAgent);
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
            },
          } as unknown as SSEEventPayload;
          yield {
            type: "claude_runtime_task_updated",
            task_id: "task-b",
            patch: { status: "running", is_backgrounded: true },
          } as unknown as SSEEventPayload;
          yield {
            type: "claude_runtime_task_notification",
            task_id: "task-b",
            status: "completed",
            summary: "second task done",
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

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(addInterventionCalls).toBe(1);
    expect(turnCount).toBe(2);
    expect(prompts[1]).toContain("task-a");
    expect(prompts[1]).toContain("task-b");
    expect(prompts[1]).toContain("/tmp/a.output");
    expect(prompts[1]).toContain("second task done");
    expect(prompts[1].indexOf("task-a")).toBeLessThan(prompts[1].indexOf("task-b"));
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

      executor.startExecution(task, claudeAgent);
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
      async *execute(): AsyncIterable<SSEEventPayload> {
        if (turnCount === 0) {
          turnCount += 1;
          yield { type: "assistant_message", content: "previous response", timestamp: 1 } as SSEEventPayload;
          yield { type: "complete", result: "first", timestamp: 1 } as SSEEventPayload;
          return;
        }
        turnCount += 1;
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

    executor.startExecution(task, claudeAgent);
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

    executor.startExecution(task, claudeAgent);
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
