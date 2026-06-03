import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
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
  let nextEventId = 0;
  const persistEvent = vi.fn(async () => ++nextEventId);
  const handleSideEffects = vi.fn(async (_sessionId: string, event: SSEEventPayload, task: Task) => {
    if (event.type === "text_delta" && typeof event.text === "string") {
      task.lastAssistantText = event.text;
    }
    if (event.type === "assistant_message" && typeof event.content === "string") {
      task.lastAssistantText = event.content;
    }
  });
  const persistence = { persistEvent, handleSideEffects } as unknown as EventPersistence;

  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;

  return { persistence, db, broadcaster };
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
      queueFallback: vi.fn(),
    };
    const capturedPrompts: string[] = [];
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedPrompts.push(params.prompt);
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
    expect(followup.collect).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ type: "claude_runtime_task_notification", task_id: "task-1" }),
    );
    expect(task.status).toBe("completed");
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

  it("runtime follow-up turn이 직전 응답을 반복해도 같은 task follow-up을 재주입하지 않는다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    let flushCalls = 0;
    const queueFallback = vi.fn();
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
      queueFallback,
    };
    const prompts: string[] = [];
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        prompts.push(params.prompt);
        if (turnCount === 0) {
          turnCount += 1;
          yield { type: "assistant_message", content: "previous response", timestamp: 1 } as SSEEventPayload;
          yield { type: "complete", result: "first", timestamp: 1 } as SSEEventPayload;
          return;
        }
        if (turnCount === 1) {
          turnCount += 1;
          yield { type: "assistant_message", content: "previous response", timestamp: 2 } as SSEEventPayload;
          yield { type: "complete", result: "repeated", timestamp: 2 } as SSEEventPayload;
          return;
        }
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
    expect(prompts).toEqual(["hi", "runtime follow-up prompt"]);
    expect(queueFallback).not.toHaveBeenCalled();
    const errorBroadcast = mocks.broadcaster.emitEventEnvelope.mock.calls.find(
      (call) =>
        (call[1] as { type: string }).type === "error" &&
        (call[1] as { error_code?: string }).error_code ===
          "claude_runtime_followup_stalled",
    );
    expect(errorBroadcast?.[1]).toMatchObject({
      type: "error",
      fatal: false,
      error_code: "claude_runtime_followup_stalled",
    });
    expect(task.lastAssistantText).toBe("previous response");
  });

  it("runtime follow-up fallback attempt도 반복되면 nonfatal error event로 사용자에게 알린다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    let flushCalls = 0;
    const followup: ClaudeRuntimeTaskFollowupPort = {
      collect: vi.fn(),
      flush: vi.fn(async (target) => {
        if (flushCalls > 0) return;
        flushCalls += 1;
        target.interventionQueue.push({
          text: "runtime follow-up retry",
          user: "system",
          source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
          followupAttempt: 2,
          followupKey: "sess-1:task-1",
        });
      }),
      queueFallback: vi.fn(),
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
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(followup.queueFallback).not.toHaveBeenCalled();
    const errorBroadcast = mocks.broadcaster.emitEventEnvelope.mock.calls.find(
      (call) =>
        (call[1] as { type: string }).type === "error" &&
        (call[1] as { error_code?: string }).error_code ===
          "claude_runtime_followup_stalled",
    );
    expect(errorBroadcast?.[1]).toMatchObject({
      type: "error",
      fatal: false,
      error_code: "claude_runtime_followup_stalled",
    });
    expect(task.status).toBe("completed");
  });
});
