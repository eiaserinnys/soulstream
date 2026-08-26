import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
  SupportsToolApproval,
} from "../../src/engine/protocol.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../../src/engine/claude_options.js";
import { UnknownModelPresetError } from "../../src/model_catalog.js";
import {
  engineEventFrame,
  RUNNER_FRAME_PROTOCOL_VERSION,
} from "../../src/runner/frame_protocol.js";
import { RunnerProcessEngineProxy } from "../../src/runner/runner_process_engine_proxy.js";
import { RunnerOrphanedSpawnError } from
  "../../src/runner/runner_process_dispatcher.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import {
  TaskExecutor,
  isTerminalStatus,
  type RunnerProcessRuntimeFactory,
} from "../../src/task/task_executor.js";
import { TaskDeliveryTurnReceipt } from
  "../../src/task/task_delivery_turn_receipt.js";
import { ExecutionOwnershipBackoff } from
  "../../src/task/execution_ownership_backoff.js";
import { TaskTurnInputBuilder } from "../../src/task/task_turn_input_builder.js";
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

const claudeAgent: AgentProfile = {
  id: "claude-roselin",
  name: "로젤린",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
};

/** AsyncIterable로 주어진 이벤트 시퀀스를 yield하는 fake EnginePort. */
function makeFakeEngine(
  events: SSEEventPayload[],
  opts: { throwAt?: number } = {},
): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/codex-default",
    async *execute(): AsyncIterable<SSEEventPayload> {
      const total = Math.max(events.length, (opts.throwAt ?? -1) + 1);
      for (let i = 0; i < total; i++) {
        if (opts.throwAt === i) throw new Error("engine boom");
        if (i < events.length) yield events[i];
      }
    },
    async interrupt() { return true; },
    async close() {},
  };
}

function makeTask(): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: agent.id,
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
  const {
    persistence,
    enqueueEvent: persistEvent,
    enqueueMetadataEffect,
    handleSideEffects,
  } = persistenceDouble;

  const updateSession = vi.fn().mockResolvedValue(undefined);
  const setClaudeSessionId = vi.fn().mockResolvedValue(undefined);
  const getSession = vi.fn().mockResolvedValue(null);
  const db = { updateSession, setClaudeSessionId, getSession } as unknown as SessionDB;

  const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
  const emitSessionUpdated = vi.fn().mockResolvedValue(undefined);
  const broadcaster = { emitEventEnvelope, emitSessionUpdated } as unknown as SessionBroadcaster;

  return {
    persistence,
    db,
    broadcaster,
    persistEvent,
    waitForSessionAck: persistenceDouble.waitForSessionAck,
    enqueueEventAndWaitForSessionAck:
      persistenceDouble.enqueueEventAndWaitForSessionAck,
    enqueueRunningTransitionAndWaitForApplication:
      persistenceDouble.enqueueRunningTransitionAndWaitForApplication,
    enqueueTerminalTransitionAndWaitForApplication:
      persistenceDouble.enqueueTerminalTransitionAndWaitForApplication,
    enqueueMetadataEffect,
    handleSideEffects,
    updateSession,
    setClaudeSessionId,
    getSession,
    emitEventEnvelope,
    emitSessionUpdated,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("TaskExecutor.startExecution", () => {
  it("sends a prepare_session command frame before starting the event stream", async () => {
    const mocks = makeMocks();
    const prepareSessionRuntime = vi.fn();
    const engine: EnginePort = {
      ...makeFakeEngine([{ type: "complete", timestamp: 1 }]),
      backendId: "claude",
      prepareSessionRuntime,
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();

    executor.startExecution(task, claudeAgent);

    await task.executionPromise;
    expect(prepareSessionRuntime).toHaveBeenCalledWith(task.agentSessionId);
  });

  it("keeps the legacy factory call exact when no preset is selected", async () => {
    const mocks = makeMocks();
    const factory = vi.fn(() => makeFakeEngine([
      { type: "assistant_message", content: "legacy", timestamp: 1 },
    ] as SSEEventPayload[]));
    const executor = new TaskExecutor(
      factory,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]).toEqual([agent]);
  });

  it("uses the preset backend while retaining the persisted resolved model", async () => {
    const mocks = makeMocks();
    const presetEngine: EnginePort = {
      ...makeFakeEngine([
        { type: "assistant_message", content: "preset", timestamp: 1 },
      ] as SSEEventPayload[]),
      backendId: "claude",
    };
    const factory = vi.fn(() => presetEngine);
    const executor = new TaskExecutor(
      factory,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        resolve: () => ({
          id: "kimi-2",
          label: "Kimi - 2",
          backend: "claude",
          model: "new-catalog-model",
        }),
      },
    );
    const task = {
      ...makeTask(),
      modelPreset: "kimi-2",
      model: "persisted-kimi-model",
    };

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(factory).toHaveBeenCalledWith(agent, "claude");
    expect(task.model).toBe("persisted-kimi-model");
  });

  it("warns and resumes with the profile backend when a persisted preset was removed", async () => {
    const mocks = makeMocks();
    const warningLogger = pino({ level: "silent" });
    const warn = vi.spyOn(warningLogger, "warn");
    const fallbackAgent: AgentProfile = {
      ...claudeAgent,
      env: {
        ANTHROPIC_API_KEY: "legacy-profile-key",
        ANTHROPIC_BASE_URL: "https://legacy.example/anthropic",
      },
    };
    const factory = vi.fn(() => ({
      ...makeFakeEngine([
        { type: "assistant_message", content: "degraded", timestamp: 1 },
      ] as SSEEventPayload[]),
      backendId: "claude" as const,
    }));
    const executor = new TaskExecutor(
      factory,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      warningLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        resolve: () => {
          throw new UnknownModelPresetError("removed-preset");
        },
      },
    );
    const task = {
      ...makeTask(),
      modelPreset: "removed-preset",
      model: "persisted-model",
    };

    executor.startExecution(task, fallbackAgent);
    await task.executionPromise;

    expect(factory.mock.calls[0]).toEqual([fallbackAgent]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        modelPreset: "removed-preset",
        fallbackBackend: "claude",
        profileEnvFallback: true,
      }),
      "Persisted model preset is unavailable; using the profile backend",
    );
  });

  it("gate OFF executor never enters the delivery receipt async boundary", async () => {
    const mocks = makeMocks();
    const observe = vi.spyOn(TaskDeliveryTurnReceipt.prototype, "observe");
    const consume = vi.spyOn(TaskDeliveryTurnReceipt.prototype, "consume");
    const executor = new TaskExecutor(
      () => makeFakeEngine([
        { type: "assistant_message", content: "legacy", timestamp: 1 },
      ] as SSEEventPayload[]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(observe).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    observe.mockRestore();
    consume.mockRestore();
  });

  it("#784 turn-start T0 receipt를 늦은 ACK의 T1 뒤 consume까지 보존한다", async () => {
    const mocks = makeMocks();
    const message: InterventionMessage = {
      text: "child result",
      user: "agent",
      deliveryId: "99999999-9999-4999-8999-999999999999",
      deliveryIntent: "completion_notification",
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn().mockResolvedValue(undefined),
      recordConsumed: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new TaskExecutor(
      () => makeFakeEngine([
        { type: "session", session_id: "claude-session" },
        { type: "assistant_message", content: "consumed", timestamp: 1 },
      ] as SSEEventPayload[]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      deliveryRecorder,
    );
    const task = makeTask();
    task.interventionQueue.push(message);

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(deliveryRecorder.recordTurnStarted).toHaveBeenCalledWith(message, task);
    expect(task.lastEventId).not.toBe(0);
    expect(deliveryRecorder.recordConsumed).toHaveBeenCalledWith(
      message,
      task,
      "event:0",
    );
    expect(deliveryRecorder.recordTurnStarted.mock.invocationCallOrder[0]).toBeLessThan(
      deliveryRecorder.recordConsumed.mock.invocationCallOrder[0]!,
    );
    const sessionEventCall = mocks.persistEvent.mock.calls.findIndex(
      (call) => (call[1] as { type: string }).type === "session",
    );
    expect(mocks.persistEvent.mock.invocationCallOrder[sessionEventCall]).toBeLessThan(
      deliveryRecorder.recordTurnStarted.mock.invocationCallOrder[0]!,
    );
  });

  it("queued delivery execute 실패는 receipt 없이 consume하지 않는다", async () => {
    const mocks = makeMocks();
    const message: InterventionMessage = {
      text: "runtime result",
      user: "system",
      deliveryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deliveryIntent: "runtime_followup",
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn().mockResolvedValue(undefined),
      recordConsumed: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new TaskExecutor(
      () => makeFakeEngine([], { throwAt: 0 }),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      deliveryRecorder,
    );
    const task = makeTask();
    task.interventionQueue.push(message);

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(deliveryRecorder.recordTurnStarted).not.toHaveBeenCalled();
    expect(deliveryRecorder.recordConsumed).not.toHaveBeenCalled();
  });

  it("iterator 성공 뒤 ACK barrier 실패도 delivery를 정확히 한 번 consume한다", async () => {
    const mocks = makeMocks();
    mocks.waitForSessionAck.mockRejectedValueOnce(new Error("post-iterator ACK failed"));
    const message: InterventionMessage = {
      text: "completion result",
      user: "agent",
      deliveryId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
      deliveryIntent: "completion_notification",
      source: "completion_notifier",
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn().mockResolvedValue(true),
      recordConsumed: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new TaskExecutor(
      () => makeFakeEngine([
        { type: "assistant_message", content: "observed", timestamp: 1 },
      ] as SSEEventPayload[]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      deliveryRecorder,
    );
    const task = makeTask();
    task.interventionQueue.push(message);

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(deliveryRecorder.recordConsumed).toHaveBeenCalledTimes(1);
    expect(deliveryRecorder.recordConsumed).toHaveBeenCalledWith(
      message,
      task,
      "event:0",
    );
  });

  it("turn-start receipt 기록 실패는 transcript recovery에 맡긴다", async () => {
    const mocks = makeMocks();
    const message: InterventionMessage = {
      text: "child result",
      user: "agent",
      deliveryId: "abababab-abab-4bab-8bab-abababababab",
      deliveryIntent: "completion_notification",
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn()
        .mockRejectedValueOnce(new Error("transient database error")),
      recordConsumed: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new TaskExecutor(
      () => makeFakeEngine([
        { type: "error", error: "recoverable diagnostic" },
        { type: "assistant_message", content: "consumed", timestamp: 1 },
      ] as SSEEventPayload[]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      deliveryRecorder,
    );
    const task = makeTask();
    task.interventionQueue.push(message);

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(deliveryRecorder.recordTurnStarted).toHaveBeenCalledTimes(1);
    expect(deliveryRecorder.recordConsumed).not.toHaveBeenCalled();
  });

  it("turn-start receipt가 없으면 iterator 종료만으로 consume하지 않는다", async () => {
    const mocks = makeMocks();
    const message: InterventionMessage = {
      text: "runtime result",
      user: "system",
      deliveryId: "acacacac-acac-4cac-8cac-acacacacacac",
      deliveryIntent: "runtime_followup",
      source: "claude_runtime_task_followup",
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn().mockRejectedValue(new Error("database unavailable")),
      recordConsumed: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new TaskExecutor(
      () => makeFakeEngine([
        { type: "assistant_message", content: "observed", timestamp: 1 },
      ] as SSEEventPayload[]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      deliveryRecorder,
    );
    const task = makeTask();
    task.interventionQueue.push(message);

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(deliveryRecorder.recordTurnStarted).toHaveBeenCalledTimes(1);
    expect(deliveryRecorder.recordConsumed).not.toHaveBeenCalled();
  });

  it("error 이벤트만 관측한 turn은 receipt 없이 consume하지 않는다", async () => {
    const mocks = makeMocks();
    const message: InterventionMessage = {
      text: "runtime result",
      user: "system",
      deliveryId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      deliveryIntent: "runtime_followup",
    };
    const deliveryRecorder = {
      recordTurnStarted: vi.fn().mockResolvedValue(true),
      recordConsumed: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new TaskExecutor(
      () => makeFakeEngine([
        { type: "error", error: "recoverable diagnostic" },
      ] as SSEEventPayload[]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      deliveryRecorder,
    );
    const task = makeTask();
    task.interventionQueue.push(message);

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(deliveryRecorder.recordTurnStarted).not.toHaveBeenCalled();
    expect(deliveryRecorder.recordConsumed).not.toHaveBeenCalled();
  });

  it("정상 흐름: persistent 이벤트는 ingress, transient 이벤트만 wire + 완료 후 session_updated", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_delta", text: "hello", timestamp: 1 } as SSEEventPayload,
      { type: "text_end", timestamp: 2 } as SSEEventPayload,
      { type: "assistant_message", content: "hello", timestamp: 3 } as SSEEventPayload,
    ];
    const engine = makeFakeEngine(events);
    const factory = vi.fn(() => engine);

    const executor = new TaskExecutor(
      factory,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // user_message + session + assistant_message + session_ended만 durable 저장.
    expect(mocks.persistEvent).toHaveBeenCalledTimes(4);
    expect(mocks.emitEventEnvelope).toHaveBeenCalledTimes(2);
    expect(mocks.handleSideEffects).toHaveBeenCalledTimes(5);

    // 첫 persistEvent는 user_message 영속화
    expect(mocks.persistEvent.mock.calls[0][1]).toMatchObject({
      type: "user_message",
      text: "hi",
    });

    expect(task.status).toBe("completed");
    expect(task.lastEventId).toBe(5);
    expect(task.codexThreadId).toBe("thr-1");
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(task.runner).toBeUndefined();

    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended", status: "completed" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "completed",
        termination_reason: "completed_ok",
      }),
    );
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
  });

  it("app-server live-only text chunks are broadcast-only; final assistant_message is persisted", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      {
        type: "text_start",
        timestamp: 1,
        raw_event_type: "item/started",
        tool_use_id: "item-1",
        _live_only: true,
      } as unknown as SSEEventPayload,
      {
        type: "text_delta",
        text: "Hel",
        timestamp: 2,
        raw_event_type: "item/agentMessage/delta",
        tool_use_id: "item-1",
        _live_only: true,
      } as unknown as SSEEventPayload,
      {
        type: "text_delta",
        text: "lo",
        timestamp: 3,
        raw_event_type: "item/agentMessage/delta",
        tool_use_id: "item-1",
        _live_only: true,
      } as unknown as SSEEventPayload,
      {
        type: "assistant_message",
        content: "Hello",
        timestamp: 4,
        raw_event_type: "item/completed",
        tool_use_id: "item-1",
        _final_for_live_stream: true,
      } as unknown as SSEEventPayload,
      {
        type: "text_end",
        timestamp: 4,
        raw_event_type: "item/completed",
        tool_use_id: "item-1",
        _live_only: true,
      } as unknown as SSEEventPayload,
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    const persistedTypes = mocks.persistEvent.mock.calls.map(
      (c) => (c[1] as { type: string }).type,
    );
    expect(persistedTypes).toEqual([
      "user_message",
      "assistant_message",
      "session_ended",
    ]);
    expect(mocks.emitEventEnvelope).toHaveBeenCalledTimes(4);
    expect(mocks.handleSideEffects).toHaveBeenCalledTimes(6);
    const broadcastEventIds = mocks.emitEventEnvelope.mock.calls.map(
      (c) => (c[1] as Record<string, unknown>)._event_id,
    );
    expect(broadcastEventIds).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(task.lastEventId).toBe(4);
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "completed",
        termination_reason: "completed_ok",
      }),
    );
  });

  it("신규 task attachmentPaths → user_message.attachments 보존 + 이미지 path는 engine params로 전달", async () => {
    const mocks = makeMocks();
    let capturedImageAttachmentPaths: string[] | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedImageAttachmentPaths = params.imageAttachmentPaths;
        yield { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload;
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
    );
    const task = makeTask();
    task.attachmentPaths = ["/tmp/incoming/sess/a.jpeg", "/tmp/incoming/sess/readme.txt"];
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(capturedImageAttachmentPaths).toEqual(["/tmp/incoming/sess/a.jpeg"]);
    expect(mocks.persistEvent.mock.calls[0][1]).toMatchObject({
      type: "user_message",
      attachments: ["/tmp/incoming/sess/a.jpeg", "/tmp/incoming/sess/readme.txt"],
    });
  });

  it("task.reasoningEffort를 engine.execute params로 전달한다", async () => {
    const mocks = makeMocks();
    let capturedReasoningEffort: string | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedReasoningEffort = params.reasoningEffort;
        yield { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload;
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
    );
    const task = makeTask();
    task.reasoningEffort = "low";
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(capturedReasoningEffort).toBe("low");
  });

  it("Claude task oauthToken을 task-level extraEnv로 전달하고 semantic assistant history를 영속한다", async () => {
    const mocks = makeMocks();
    let capturedExtraEnv: Record<string, string> | undefined;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedExtraEnv = params.extraEnv;
        yield { type: "session", session_id: "claude-sess-1" } as SSEEventPayload;
        yield { type: "text_start", timestamp: 1 } as SSEEventPayload;
        yield { type: "text_delta", text: "claude says hi", timestamp: 1 } as SSEEventPayload;
        yield { type: "text_end", timestamp: 1 } as SSEEventPayload;
        yield { type: "assistant_message", content: "claude says hi", timestamp: 1 } as SSEEventPayload;
        yield { type: "complete", result: "claude says hi", timestamp: 1 } as SSEEventPayload;
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
    );
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.oauthToken = "task-oauth-token";

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(capturedExtraEnv).toEqual({ [CLAUDE_OAUTH_TOKEN_ENV]: "task-oauth-token" });
    expect(task.status).toBe("completed");
    expect(task.codexThreadId).toBe("claude-sess-1");
    expect(task.lastAssistantText).toBe("claude says hi");
    expect(mocks.persistEvent).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session", session_id: "claude-sess-1" }),
      {
        kind: "set_backend_session_id",
        backend_session_id: "claude-sess-1",
      },
      1,
    );
  });

  it("Agents SDK 합성 시나리오: handoff 중 tool approval 거부 → graceful complete", async () => {
    const mocks = makeMocks();
    let resolveApproval!: () => void;
    const approvalPromise = new Promise<void>((resolve) => {
      resolveApproval = resolve;
    });
    const deliverToolApproval = vi.fn(() => {
      resolveApproval();
      return { status: "delivered" as const };
    });
    const engine: EnginePort & SupportsToolApproval = {
      backendId: "openai-agents",
      workspaceDir: "/tmp/agents",
      async *execute(): AsyncIterable<SSEEventPayload> {
        yield {
          type: "handoff_requested",
          source_agent: "Triage",
          target_agent: "Database specialist",
          tool_use_id: "handoff-call-1",
          timestamp: 1,
        } as SSEEventPayload;
        yield {
          type: "handoff_occurred",
          source_agent: "Triage",
          target_agent: "Database specialist",
          tool_use_id: "handoff-call-1",
          timestamp: 2,
        } as SSEEventPayload;
        yield {
          type: "tool_approval_requested",
          approval_id: "danger-call-1",
          tool_use_id: "danger-call-1",
          tool_name: "drop_rows",
          tool_input: { table: "events" },
          agent_name: "Database specialist",
          timestamp: 3,
        } as SSEEventPayload;
        await approvalPromise;
        yield {
          type: "complete",
          result: "Rejected dangerous tool and stopped safely",
          attachments: [],
          timestamp: 4,
        } as SSEEventPayload;
      },
      deliverToolApproval,
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    task.profileId = "agent-openai";
    executor.startExecution(task, { ...agent, id: "agent-openai", backend: "openai-agents" });

    await waitFor(() => mocks.persistEvent.mock.calls.some(
      (c) => (c[1] as { type: string }).type === "tool_approval_requested",
    ));
    const approvalResult = await (task.runner?.engine as EnginePort & SupportsToolApproval)
      .deliverToolApproval("danger-call-1", "rejected", { message: "no prod write" });
    await task.executionPromise;

    expect(approvalResult).toEqual({ status: "delivered" });
    expect(deliverToolApproval).toHaveBeenCalledWith(
      "danger-call-1",
      "rejected",
      { message: "no prod write" },
    );
    expect(task.status).toBe("completed");
    const persistedTypes = mocks.persistEvent.mock.calls.map(
      (c) => (c[1] as { type: string }).type,
    );
    expect(persistedTypes).toEqual(expect.arrayContaining([
      "handoff_requested",
      "handoff_occurred",
      "tool_approval_requested",
      "complete",
    ]));
  });

  it("Agents SDK RunState와 Session items를 metadata에 영속하고 resume params로 되돌림", async () => {
    const mocks = makeMocks();
    let captured: EngineExecuteParams | undefined;
    const engine: EnginePort = {
      backendId: "openai-agents",
      workspaceDir: "/tmp/agents",
      async *execute(): AsyncIterable<SSEEventPayload> {},
      async *executeFrames(params: EngineExecuteParams) {
        captured = params;
        yield {
          protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
          channel: "event" as const,
          kind: "run_state_snapshot" as const,
          snapshot: {
            backendId: "openai-agents" as const,
            serialized: "state-v2",
            pendingApprovalId: "danger-call-1",
            previousResponseId: "resp-2",
            conversationId: "conv-2",
            schemaVersion: "1.11",
          },
        };
        yield {
          protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
          channel: "event" as const,
          kind: "session_items_snapshot" as const,
          snapshot: {
            backendId: "openai-agents" as const,
            items: [{ role: "user", content: "hi" }],
          },
        };
        yield engineEventFrame({
          type: "complete",
          result: "resumed",
          attachments: [],
          timestamp: 4,
        });
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
    );
    const task = makeTask();
    task.profileId = "agent-openai";
    task.agentsRunState = "state-v1";
    task.agentsPreviousResponseId = "resp-1";
    task.agentsConversationId = "conv-1";
    task.agentsSessionItems = [{ role: "system", content: "old" }];
    task.agentsQueuedToolApproval = {
      approvalId: "danger-call-1",
      decision: "rejected",
      options: { message: "no prod write" },
    };

    executor.startExecution(task, { ...agent, id: "agent-openai", backend: "openai-agents" });
    await task.executionPromise;

    expect(captured).toMatchObject({
      resumeRunState: "state-v1",
      previousResponseId: "resp-1",
      conversationId: "conv-1",
      sessionItems: [{ role: "system", content: "old" }],
      queuedToolApproval: {
        approvalId: "danger-call-1",
        decision: "rejected",
        options: { message: "no prod write" },
      },
    });
    expect(task.agentsRunState).toBe("state-v2");
    expect(task.agentsPendingApprovalId).toBe("danger-call-1");
    expect(task.agentsSessionItems).toEqual([{ role: "user", content: "hi" }]);
    expect(mocks.enqueueMetadataEffect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "agents_run_state",
        value: expect.objectContaining({
          serialized: "state-v2",
          pendingApprovalId: "danger-call-1",
          previousResponseId: "resp-2",
          conversationId: "conv-2",
        }),
      }),
      { replaceExistingType: "agents_run_state" },
    );
    expect(mocks.enqueueMetadataEffect).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "agents_session_items",
        value: expect.objectContaining({
          items: [{ role: "user", content: "hi" }],
        }),
      }),
      { replaceExistingType: "agents_session_items" },
    );
  });

  it("engine.execute throw → status=error + finalize", async () => {
    const mocks = makeMocks();
    const engine = makeFakeEngine(
      [{ type: "session", session_id: "thr-1" } as SSEEventPayload],
      { throwAt: 1 },  // index 1에서 throw — 첫 yield는 통과
    );
    const factory = vi.fn(() => engine);
    const executor = new TaskExecutor(factory, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("error");
    expect(task.error).toContain("engine boom");
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended", status: "error" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "error",
        termination_reason: "error_aborted",
        termination_detail: "engine boom",
      }),
    );
  });

  it("Claude fatal error event 후 throw → error event를 남기고 task status=error로 finalize", async () => {
    const mocks = makeMocks();
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        yield { type: "error", message: "claude boom", fatal: true, timestamp: 1 } as SSEEventPayload;
        throw new Error("claude boom");
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
    );
    const task = makeTask();
    task.profileId = claudeAgent.id;

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(task.status).toBe("error");
    expect(task.error).toContain("claude boom");
    expect(mocks.persistEvent.mock.calls[1][1]).toMatchObject({
      type: "error",
      message: "claude boom",
      fatal: true,
    });
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended", status: "error" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "error",
        termination_reason: "error_aborted",
      }),
    );
  });

  it("Claude rate-limit StopFailure fatal event finalizes as limit_hit without a persistent timeout", async () => {
    const mocks = makeMocks();
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        yield {
          type: "credential_alert",
          status: "rejected",
          rate_limit_type: "five_hour",
          timestamp: 1,
        } as SSEEventPayload;
        yield {
          type: "assistant_error",
          error_type: "rate_limit",
          timestamp: 2,
        } as SSEEventPayload;
        yield {
          type: "assistant_message",
          text: "You've hit your usage limit.",
          timestamp: 3,
        } as SSEEventPayload;
        yield {
          type: "claude_runtime_hook_event",
          hook_event_name: "StopFailure",
          hook_input: { error: "rate_limit" },
          timestamp: 4,
        } as SSEEventPayload;
        yield {
          type: "error",
          message: "Claude foreground turn stopped after a rate-limit rejection.",
          error_code: "claude_rate_limit_stop_failure",
          fatal: true,
          timestamp: 5,
        } as SSEEventPayload;
        throw new Error("Claude foreground turn stopped after a rate-limit rejection.");
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
    );
    const task = makeTask();
    task.profileId = claudeAgent.id;

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(task.status).toBe("error");
    expect(task.error).toBe(
      "Claude foreground turn stopped after a rate-limit rejection.",
    );
    expect(mocks.persistEvent.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant_message",
          text: "You've hit your usage limit.",
        }),
        expect.objectContaining({
          type: "claude_runtime_hook_event",
          hook_event_name: "StopFailure",
        }),
        expect.objectContaining({
          type: "error",
          error_code: "claude_rate_limit_stop_failure",
          fatal: true,
        }),
      ]),
    );
    expect(mocks.persistEvent.mock.calls.map((call) => call[1])).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error_code: "claude_persistent_turn_timeout",
        }),
      ]),
    );
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended", status: "error" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "error",
        termination_reason: "limit_hit",
        termination_detail: "credential_alert",
      }),
    );
  });

  it("Claude runtime timeout fatal event clears pending runtime and finalizes as error", async () => {
    const mocks = makeMocks();
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        yield {
          type: "claude_runtime_session_state",
          state: "running",
          session_id: "claude-sess-timeout",
        } as SSEEventPayload;
        yield {
          type: "claude_runtime_task_started",
          task_id: "task-bg-timeout",
          task_type: "bash",
        } as SSEEventPayload;
        yield {
          type: "debug",
          message: "Claude runtime drain timed out after 30ms; closing query.",
        } as SSEEventPayload;
        yield {
          type: "claude_runtime_task_notification",
          task_id: "task-bg-timeout",
          status: "failed",
          summary: "Claude runtime drain timed out after 30ms; closing query.",
        } as SSEEventPayload;
        yield {
          type: "claude_runtime_session_state",
          state: "idle",
          session_id: "claude-sess-timeout",
        } as SSEEventPayload;
        yield {
          type: "error",
          message: "Claude runtime drain timed out after 30ms; closing query.",
          error_code: "claude_runtime_timeout",
          fatal: true,
        } as SSEEventPayload;
        throw new Error("Claude runtime drain timed out after 30ms; closing query.");
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
    );
    const task = makeTask();
    task.profileId = claudeAgent.id;

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(task.status).toBe("error");
    expect(task.error).toBe("Claude runtime drain timed out after 30ms; closing query.");
    expect(task.runner).toBeUndefined();
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(task.claudeRuntime).toMatchObject({
      sessionState: "idle",
      tasks: {
        "task-bg-timeout": {
          status: "failed",
        },
      },
    });
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended", status: "error" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "error",
        termination_reason: "error_aborted",
      }),
    );
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
  });

  it("idle Claude runtime with lingering unmarked task completes without pending-after-turn fatal", async () => {
    const mocks = makeMocks();
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        yield { type: "complete", result: "done", timestamp: 1 } as SSEEventPayload;
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
    );
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.claudeRuntime = {
      sessionState: "idle",
      updatedAt: Date.now(),
      tasks: {
        "lingering-unmarked": {
          taskId: "lingering-unmarked",
          status: "running",
          updatedAt: Date.now(),
          description: "background task that did not carry an isBackgrounded flag",
        },
      },
    };

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(task.status).toBe("completed");
    expect(task.error).toBeUndefined();
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(task.runner).toBeUndefined();
    expect(task.claudeRuntime).toMatchObject({
      sessionState: "idle",
      tasks: {
        "lingering-unmarked": {
          status: "running",
        },
      },
    });
    const pendingAfterTurnError = mocks.persistEvent.mock.calls.find(
      (call) =>
        (call[1] as { error_code?: string }).error_code ===
        "claude_runtime_pending_after_turn",
    );
    expect(pendingAfterTurnError).toBeUndefined();
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended", status: "completed" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "completed",
        termination_reason: "completed_ok",
      }),
    );
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
  });

  it("active Claude runtime session after turn emits recoverable fatal error and finalizes", async () => {
    const mocks = makeMocks();
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        yield { type: "complete", result: "done", timestamp: 1 } as SSEEventPayload;
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
    );
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.claudeRuntime = {
      sessionState: "running",
      updatedAt: Date.now(),
      tasks: {
        "active-runtime-task": {
          taskId: "active-runtime-task",
          status: "running",
          updatedAt: Date.now(),
          description: "runtime session still active after turn",
        },
      },
    };

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(task.status).toBe("error");
    expect(task.error).toContain("Claude runtime session remained active after the engine turn ended");
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(task.runner).toBeUndefined();
    expect(task.claudeRuntime).toMatchObject({
      sessionState: "idle",
      tasks: {
        "active-runtime-task": {
          status: "failed",
          error: expect.stringContaining("runtime session remained active"),
        },
      },
    });
    const errorPersist = mocks.persistEvent.mock.calls.find(
      (call) => (call[1] as { type: string }).type === "error",
    );
    expect(errorPersist?.[1]).toMatchObject({
      type: "error",
      fatal: true,
      recoverable: true,
      recovery_hint: expect.stringContaining("Send another message"),
      error_code: "claude_runtime_pending_after_turn",
    });
    expect(mocks.emitEventEnvelope.mock.calls.some(
      (call) => (call[1] as { type: string }).type === "error",
    )).toBe(false);
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended", status: "error" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "error",
        termination_reason: "error_aborted",
      }),
    );
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
  });

  it("persistent ingress 실패는 turn을 중단하고 terminal error를 남긴다", async () => {
    const mocks = makeMocks();
    mocks.persistEvent.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    mocks.persistEvent.mockImplementation(async () => 99);

    const events: SSEEventPayload[] = [
      { type: "assistant_message", content: "a", timestamp: 1 } as SSEEventPayload,
      { type: "complete", result: "a", timestamp: 2 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("error");
    expect(mocks.persistEvent).toHaveBeenCalledTimes(2);
    expect((mocks.persistEvent.mock.calls[1][1] as SSEEventPayload).type).toBe("session_ended");
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("session 이벤트의 session_id가 task.codexThreadId에 박힘 (1회만)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-first" } as SSEEventPayload,
      { type: "session", session_id: "thr-second" } as SSEEventPayload,  // 두 번째는 무시
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;
    expect(task.codexThreadId).toBe("thr-first");
  });

  // === F-3B: Codex thread id DB 영속화 ===

  it("F-3B T6: 첫 session 이벤트에 backend-session effect를 붙이고 두 번째는 생략", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-codex-1" } as SSEEventPayload,
      { type: "text_delta", text: "hi", timestamp: 1 } as SSEEventPayload,
      { type: "session", session_id: "thr-codex-2" } as SSEEventPayload,  // 두 번째 session은 무시 (가드)
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // 메모리: 첫 thread id만 박힘 (기존 동작 유지)
    expect(task.codexThreadId).toBe("thr-codex-1");

    const backendEffects = mocks.persistEvent.mock.calls
      .map((call) => call[2])
      .filter((effect) => effect?.kind === "set_backend_session_id");
    expect(backendEffects).toEqual([
      {
        kind: "set_backend_session_id",
        backend_session_id: "thr-codex-1",
      },
    ]);
  });

  it("F-3A 회귀: handleSideEffects throw (DB 실패 등) → 격리, task 진행 계속", async () => {
    // handleSideEffects는 EventPersistence가 DB throw를 호출자에 전파한다 (Python 정합).
    // TaskEngineEventPublisher의 try-catch가 이를 받아 task 진행을 막지 않아야 한다.
    const mocks = makeMocks();
    mocks.handleSideEffects.mockRejectedValueOnce(
      new Error("last_message db down"),
    );
    const events: SSEEventPayload[] = [
      { type: "assistant_message", content: "a", timestamp: 1 } as SSEEventPayload,
      { type: "complete", result: "a", timestamp: 2 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("completed");
    // user_message(1) + assistant_message + complete = 3건 (첫 handleSideEffects throw에도 다음 이벤트 진행)
    expect(mocks.persistEvent).toHaveBeenCalledTimes(4);
    expect(mocks.handleSideEffects).toHaveBeenCalledTimes(3);
  });

  it("F-3B T7: backend-session effect는 worker DB를 호출하지 않고 task를 완료", async () => {
    const mocks = makeMocks();

    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-codex-1" } as SSEEventPayload,
      { type: "text_delta", text: "after error", timestamp: 1 } as SSEEventPayload,
      { type: "assistant_message", content: "after error", timestamp: 2 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("completed");
    expect(task.codexThreadId).toBe("thr-codex-1");
    // user_message(1) + session(2) + assistant_message(3) = 3건 durable 저장
    expect(mocks.persistEvent).toHaveBeenCalledTimes(4);
    expect(mocks.persistEvent).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session", session_id: "thr-codex-1" }),
      {
        kind: "set_backend_session_id",
        backend_session_id: "thr-codex-1",
      },
      1,
    );
  });

  it("같은 task에 startExecution 두 번 호출 → throw", () => {
    const mocks = makeMocks();
    const engine = makeFakeEngine([]);
    const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    expect(() => executor.startExecution(task, agent)).toThrow(/admission in flight/);
  });

  it("정상 turn 종료가 진행 중인 interrupt ACK를 기다려 completed로 덮지 않는다", async () => {
    const mocks = makeMocks();
    const turnStarted = deferred<void>();
    const finishTurn = deferred<void>();
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute() {
        turnStarted.resolve();
        yield { type: "session", session_id: "thr-1" } as SSEEventPayload;
        await finishTurn.promise;
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
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await turnStarted.promise;
    const interrupt = deferred<boolean>();
    task.interruptRequest = interrupt.promise.then((accepted) => {
      if (accepted) task.status = "interrupted";
      return accepted;
    });
    finishTurn.resolve();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(task.status).toBe("running");
    expect(task.executionPromise).toBeDefined();

    interrupt.resolve(true);
    await task.executionPromise;

    expect(task.status).toBe("interrupted");
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended", status: "interrupted" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "interrupted",
        termination_reason: "unknown",
      }),
    );
  });

  it("live intervention stays inside the same execution until its result completes", async () => {
    const mocks = makeMocks();
    const turnStarted = deferred<void>();
    const interventionAccepted = deferred<void>();
    const finishIntervention = deferred<void>();
    const execute = vi.fn(async function* (): AsyncIterable<SSEEventPayload> {
      turnStarted.resolve();
      yield { type: "session", session_id: "claude-sess-1" } as SSEEventPayload;
      await interventionAccepted.promise;
      await finishIntervention.promise;
      yield { type: "assistant_message", content: "heard" } as SSEEventPayload;
      yield { type: "complete", result: "heard", timestamp: 1 } as SSEEventPayload;
    });
    const intervene = vi.fn(async () => {
      interventionAccepted.resolve();
      return {
        status: "delivered" as const,
        mechanism: "interrupt_then_next_turn" as const,
      };
    });
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      execute,
      intervene,
      async interrupt() { return true; },
      async close() {},
    };
    const factory = vi.fn(() => engine);
    const executor = new TaskExecutor(
      factory,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    task.profileId = claudeAgent.id;

    executor.startExecution(task, claudeAgent);
    await turnStarted.promise;
    const executionPromise = task.executionPromise;
    const delivery = await task.runner!.engine.intervene({ prompt: "new input" });

    expect(delivery.status).toBe("delivered");
    expect(task.status).toBe("running");
    expect(task.error).toBeUndefined();
    expect(task.pendingTerminationHint).toBeUndefined();
    expect(task.executionPromise).toBe(executionPromise);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();

    finishIntervention.resolve();
    await task.executionPromise;

    expect(task.status).toBe("completed");
    expect(task.error).toBeUndefined();
    expect(task.pendingTerminationHint).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended", status: "completed" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "completed",
        termination_reason: "completed_ok",
      }),
    );
  });

  it("engineFactory throw → admission reject + status=error, finalize 호출", async () => {
    const mocks = makeMocks();
    const factory = vi.fn(() => {
      throw new Error("factory boom");
    });
    const executor = new TaskExecutor(factory, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    const execution = executor.startExecution(task, agent);
    const activation = task.executionActivationPromise!;
    await execution;
    await expect(activation).rejects.toThrow(/factory boom/);
    expect(task.runner).toBeUndefined();
    expect(task.status).toBe("error");
  });

  it("outer execution failure finalizes without deleting queued interventions", async () => {
    const mocks = makeMocks();
    const engine = makeFakeEngine([]);
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    task.interventionQueue.push(
      { text: "pending 1", user: "u" },
      { text: "pending 2", user: "u" },
    );
    const prepareSpy = vi
      .spyOn(TaskTurnInputBuilder.prototype, "prepareInitialTurnInput")
      .mockRejectedValueOnce(new Error("prepare boom"));

    try {
      executor.startExecution(task, agent);
      await task.executionPromise;
    } finally {
      prepareSpy.mockRestore();
    }

    expect(task.status).toBe("error");
    expect(task.error).toBe("prepare boom");
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(task.interventionQueue).toEqual([
      { text: "pending 1", user: "u" },
      { text: "pending 2", user: "u" },
    ]);
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended", status: "error" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "error",
        termination_reason: "error_aborted",
        termination_detail: "prepare boom",
      }),
    );
    const skippedBroadcast = mocks.emitEventEnvelope.mock.calls.find(
      (c) => /queued intervention\(s\) skipped/.test(
        String((c[1] as { message?: string }).message),
      ),
    );
    expect(skippedBroadcast).toBeUndefined();
  });

  // === B-7: 피위임 완료 회송 (CompletionNotifier 주입 회귀) ===

  it("B-7: callerSessionId 있고 notifier 주입 시 finalize 후 notify 1회 호출", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_delta", text: "child result", timestamp: 1 } as SSEEventPayload,
      { type: "text_end", timestamp: 2 } as SSEEventPayload,
    ];
    const notify = vi.fn().mockResolvedValue(undefined);
    const notifier = { notify };
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      notifier,
    );
    const task = makeTask();
    task.callerSessionId = "parent-sess-1";
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("completed");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(task);
  });

  it("B-7: callerSessionId 없으면 notifier 주입되어도 notify 호출 안 됨", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_end", timestamp: 1 } as SSEEventPayload,
    ];
    const notify = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      { notify },
    );
    const task = makeTask();
    // callerSessionId 미설정
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(notify).not.toHaveBeenCalled();
  });

  it("B-7: notifier 미주입(legacy) — finalize 정상 + notify 의존성 없음", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_end", timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      // contextBuilder, completionNotifier 모두 미주입 (기존 테스트 회귀)
    );
    const task = makeTask();
    task.callerSessionId = "parent-sess-1";  // 있어도 notifier 없으면 호출 안 됨
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("completed");
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "session_ended" }),
      expect.objectContaining({ kind: "terminal_transition", status: "completed" }),
    );
  });

  it("B-7: notifier.notify가 throw해도 finalize는 격리 (task.status 그대로)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_end", timestamp: 1 } as SSEEventPayload,
    ];
    // notifier가 throw — 운영 시 발생하면 안 되지만 안전망 검증
    const notify = vi.fn().mockRejectedValue(new Error("notifier boom"));
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      { notify },
    );
    const task = makeTask();
    task.callerSessionId = "parent-sess-1";
    executor.startExecution(task, agent);

    // executionPromise는 정상 resolve (finalize에서 throw 격리됨)
    await expect(task.executionPromise).resolves.toBeUndefined();
    expect(task.status).toBe("completed");
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("TaskExecutor runner process boundary", () => {
  it("selects the process runtime without touching the in-process engine factory", async () => {
    const mocks = makeMocks();
    const engineFactory = vi.fn(() => makeFakeEngine([]));
    const { runner, dispatcher } = makeRunnerProcessRuntime([
      { type: "complete", result: "done", timestamp: 1 },
    ]);
    const processFactory = vi.fn(() => runner) as unknown as RunnerProcessRuntimeFactory;
    processFactory.describe = vi.fn(async () => ({
      ownerKind: "runner_process",
      manifestId: "release-1",
      runtimeEnvIdentity: "env-1",
    }));
    const executor = new TaskExecutor(
      engineFactory,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      processFactory,
    );
    const task = makeTask();

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(processFactory).toHaveBeenCalledWith(
      task,
      agent,
      "codex",
      expect.objectContaining({
        persistRunState: expect.any(Function),
        persistSessionItems: expect.any(Function),
      }),
    );
    expect(engineFactory).not.toHaveBeenCalled();
    expect(dispatcher.prepareSession).toHaveBeenCalledWith(task.agentSessionId);
    expect(dispatcher.executeFrames).toHaveBeenCalledOnce();
    expect(task.status).toBe("completed");
  });

  it.each([
    { entryPath: "initial" as const, expectedTerminalEventId: undefined },
    { entryPath: "auto_resume" as const, expectedTerminalEventId: 77 },
  ])(
    "$entryPath ownership은 complete identity proof → sessions acquire 뒤 실행한다",
    async ({ entryPath, expectedTerminalEventId }) => {
      const mocks = makeMocks();
      const transition = (status: "running" | "completed") => ({
        eventId: status === "running" ? 11 : 12,
        applied: true,
        canonicalSession: {
          status,
          termination_reason: status === "completed" ? "completed_ok" : null,
          termination_detail: null,
          review_state: "not_required",
          last_assistant_text: null,
          termination_event_id: status === "completed" ? 12 : null,
          updated_at: "2026-08-18T00:00:00.000Z",
          last_event_id: status === "completed" ? 12 : null,
        },
      });
      const acquire = vi.fn(async (_sessionId, input) => ({
        ...transition("running"),
        canonicalExecutionOwnership: {
          ownershipGeneration: 7,
          ownerKind: input.ownerKind,
          manifestId: input.manifestId,
          runtimeEnvIdentity: input.runtimeEnvIdentity,
          registrationId: input.registrationId,
          pid: input.pid,
          startIdentity: input.startIdentity,
          executionCommandId: input.executionCommandId,
          phase: "active",
          failureReason: null,
        },
      }));
      const terminal = vi.fn(async () => transition("completed"));
      Object.assign(mocks.persistence, {
        acquireExecutionOwnershipAndWaitForApplication: acquire,
        releaseExecutionOwnershipAndWaitForApplication: terminal,
      });
      const { runner, dispatcher } = makeRunnerProcessRuntime([
        { type: "complete", result: "done", timestamp: 1 },
      ]);
      const proof = {
        registrationId: "registration-1",
        pid: 321,
        startIdentity: "start-1",
        executionCommandId: "execute-1",
      };
      dispatcher.prepareExecutionIdentity = vi.fn(async () => proof);
      const processFactory = vi.fn(() => runner) as unknown as RunnerProcessRuntimeFactory;
      processFactory.describe = vi.fn(async () => ({
        ownerKind: "runner_process",
        manifestId: "release-1",
        runtimeEnvIdentity: "env-1",
      }));
      const executor = new TaskExecutor(
        () => makeFakeEngine([]),
        mocks.db,
        mocks.persistence,
        mocks.broadcaster,
        silentLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        processFactory,
      );
      const task = makeTask();
      task.status = "initializing";
      task.pendingExecutionExpectedTerminalEventId = expectedTerminalEventId;

      await executor.startExecution(task, agent);

      expect(acquire).toHaveBeenCalledWith(task.agentSessionId, expect.objectContaining({
        ownerKind: "runner_process",
        manifestId: "release-1",
        runtimeEnvIdentity: "env-1",
        ...proof,
        reviewState: "not_required",
        ...(expectedTerminalEventId === undefined
          ? {}
          : { expectedTerminalEventId }),
      }));
      expect(dispatcher.prepareExecutionIdentity.mock.invocationCallOrder[0]).toBeLessThan(
        acquire.mock.invocationCallOrder[0]!,
      );
      expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(
        dispatcher.executeFrames.mock.invocationCallOrder[0]!,
      );
      expect(terminal).toHaveBeenCalledWith(
        task.agentSessionId,
        expect.objectContaining({ type: "session_ended" }),
        expect.objectContaining({
          ownershipGeneration: 7,
          executionCommandId: proof.executionCommandId,
        }),
      );
      expect(task.executionOwnership).toBeUndefined();
      expect(task.pendingExecutionExpectedTerminalEventId).toBeUndefined();
      expect(entryPath).toBe(
        expectedTerminalEventId === undefined ? "initial" : "auto_resume",
      );
    },
  );

  it("새 스폰은 복구된 과거 manifest 대신 현재 호스트 identity로 acquire한다", async () => {
    const mocks = makeMocks();
    const transition = (status: "running" | "completed") => ({
      eventId: status === "running" ? 11 : 12,
      applied: true,
      canonicalSession: {
        status,
        termination_reason: status === "completed" ? "completed_ok" : null,
        termination_detail: null,
        review_state: "not_required",
        last_assistant_text: null,
        termination_event_id: status === "completed" ? 12 : null,
        updated_at: "2026-08-21T00:00:00.000Z",
        last_event_id: status === "completed" ? 12 : null,
      },
    });
    const acquire = vi.fn(async (_sessionId, input) => ({
      ...transition("running"),
      canonicalExecutionOwnership: {
        ownershipGeneration: 8,
        ownerKind: input.ownerKind,
        manifestId: input.manifestId,
        runtimeEnvIdentity: input.runtimeEnvIdentity,
        registrationId: input.registrationId,
        pid: input.pid,
        startIdentity: input.startIdentity,
        executionCommandId: input.executionCommandId,
        phase: "active",
        failureReason: null,
      },
    }));
    const terminal = vi.fn(async () => transition("completed"));
    Object.assign(mocks.persistence, {
      acquireExecutionOwnershipAndWaitForApplication: acquire,
      releaseExecutionOwnershipAndWaitForApplication: terminal,
      enqueueRecoveredRunnerTerminalFactAndWaitForApplication: terminal,
    });
    const { runner, dispatcher } = makeRunnerProcessRuntime([
      { type: "complete", result: "done", timestamp: 1 },
    ]);
    const proof = {
      registrationId: "registration-b",
      pid: 4321,
      startIdentity: "start-b",
      executionCommandId: "execute-b",
    };
    dispatcher.prepareExecutionIdentity = vi.fn(async () => proof);
    const currentManifestId = "release-b";
    const processFactory = vi.fn(() => runner) as unknown as RunnerProcessRuntimeFactory;
    processFactory.describe = vi.fn(async () => ({
      ownerKind: "runner_process",
      manifestId: currentManifestId,
      runtimeEnvIdentity: "env-b",
    }));
    const executor = new TaskExecutor(
      () => makeFakeEngine([]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      processFactory,
    );
    const task = makeTask();
    task.status = "initializing";
    task.recoveredExecutionOwnership = {
      manifestId: "release-a",
      runtimeEnvIdentity: "env-a",
      registrationId: "registration-a",
      pid: 1234,
      startIdentity: "start-a",
      executionCommandId: "execute-a",
    };

    const execution = executor.startExecution(task, agent);
    const activation = task.executionActivationPromise!;
    await execution;
    await expect(activation).resolves.toBeUndefined();

    expect(processFactory.describe).toHaveBeenCalledWith(agent);
    expect(acquire).toHaveBeenCalledWith(task.agentSessionId, expect.objectContaining({
      manifestId: currentManifestId,
      runtimeEnvIdentity: "env-b",
      ...proof,
    }));
    expect(terminal).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({ type: "session_ended" }),
      expect.objectContaining({ executionCommandId: proof.executionCommandId }),
    );
    expect(task.executionOwnership).toBeUndefined();
    expect(task.recoveredExecutionOwnership).toBeUndefined();
  });

  it("does not acquire again while the shared ownership retry deadline is active", async () => {
    const mocks = makeMocks();
    const acquire = vi.fn();
    Object.assign(mocks.persistence, {
      acquireExecutionOwnershipAndWaitForApplication: acquire,
    });
    const backoff = new ExecutionOwnershipBackoff({
      logger: { warn: vi.fn(), error: vi.fn() },
      now: () => 0,
    });
    backoff.observeConflict("sess-1", new Date(60_000).toISOString());
    const { runner } = makeRunnerProcessRuntime([]);
    const processFactory = vi.fn(() => runner) as unknown as RunnerProcessRuntimeFactory;
    processFactory.describe = vi.fn(async () => ({
      ownerKind: "runner_process",
      manifestId: "release-1",
      runtimeEnvIdentity: "env-1",
    }));
    const executor = new TaskExecutor(
      () => makeFakeEngine([]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      processFactory,
      undefined,
      backoff,
    );
    const task = makeTask();
    task.status = "initializing";

    const execution = executor.startExecution(task, agent);
    const activation = task.executionActivationPromise!;
    await execution;
    await expect(activation).rejects.toThrow("Execution ownership conflict");

    expect(acquire).not.toHaveBeenCalled();
    expect(processFactory.describe).not.toHaveBeenCalled();
  });

  it.each(["identity", "acquire"] as const)(
    "%s failure closes the dormant runner before engine input",
    async (failurePoint) => {
      const mocks = makeMocks();
      const acquire = failurePoint === "acquire"
        ? vi.fn(async () => ({
          eventId: 10,
          applied: false,
          canonicalSession: {
            status: "running",
            termination_reason: null,
            termination_detail: null,
            review_state: "not_required",
            last_assistant_text: null,
            termination_event_id: null,
            updated_at: "2026-08-19T00:00:00.000Z",
            last_event_id: 10,
          },
          canonicalExecutionOwnership: null,
        }))
        : vi.fn();
      Object.assign(mocks.persistence, {
        acquireExecutionOwnershipAndWaitForApplication: acquire,
      });
      const { runner, dispatcher } = makeRunnerProcessRuntime([]);
      const proof = {
        registrationId: "registration-new",
        pid: 4321,
        startIdentity: "start-new",
        executionCommandId: "execute-new",
      };
      dispatcher.prepareExecutionIdentity = failurePoint === "identity"
        ? vi.fn(async () => undefined)
        : vi.fn(async () => proof);
      dispatcher.rollbackExecutionIdentity = vi.fn(async () => {});
      const processFactory = vi.fn(() => runner) as unknown as RunnerProcessRuntimeFactory;
      processFactory.describe = vi.fn(async () => ({
        ownerKind: "runner_process",
        manifestId: "release-new",
        runtimeEnvIdentity: "env-new",
      }));
      const executor = new TaskExecutor(
        () => makeFakeEngine([]),
        mocks.db,
        mocks.persistence,
        mocks.broadcaster,
        silentLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        processFactory,
      );
      const task = makeTask();
      task.status = "initializing";

      const execution = executor.startExecution(task, agent);
      const activation = task.executionActivationPromise!;
      await execution;
      await expect(activation).rejects.toThrow();

      expect(dispatcher.executeFrames).not.toHaveBeenCalled();
      expect(task.runner).toBeUndefined();
      if (failurePoint === "acquire") {
        expect(dispatcher.rollbackExecutionIdentity).toHaveBeenCalledWith(proof);
      } else {
        expect(dispatcher.close).toHaveBeenCalledOnce();
      }
    },
  );

  it("RunnerOrphanedSpawnError before acquire cannot claim or feed the dormant child", async () => {
    const mocks = makeMocks();
    const acquire = vi.fn();
    Object.assign(mocks.persistence, {
      acquireExecutionOwnershipAndWaitForApplication: acquire,
    });
    const { runner, dispatcher } = makeRunnerProcessRuntime([]);
    const proof = {
      registrationId: "registration-orphan",
      pid: 7_201,
      startIdentity: "start-7201",
      executionCommandId: "execute-orphan",
    };
    const orphaned = new RunnerOrphanedSpawnError(proof, new Error("child remained alive"));
    dispatcher.prepareExecutionIdentity = vi.fn(async () => { throw orphaned; });
    const processFactory = vi.fn(() => runner) as unknown as RunnerProcessRuntimeFactory;
    processFactory.describe = vi.fn(async () => ({
      ownerKind: "runner_process",
      manifestId: "release-1",
      runtimeEnvIdentity: "env-1",
    }));
    const executor = new TaskExecutor(
      () => makeFakeEngine([]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      processFactory,
    );
    const task = makeTask();
    task.status = "initializing";

    await executor.startExecution(task, agent);

    await expect(task.executionActivationPromise).rejects.toBe(orphaned);
    expect(acquire).not.toHaveBeenCalled();
    expect(dispatcher.executeFrames).not.toHaveBeenCalled();
    expect(dispatcher.close).toHaveBeenCalledOnce();
    expect(task.runner).toBeUndefined();
  });

  it("does not adopt again while the shared ownership retry deadline is active", async () => {
    const mocks = makeMocks();
    const acquire = vi.fn();
    Object.assign(mocks.persistence, {
      acquireExecutionOwnershipAndWaitForApplication: acquire,
    });
    const backoff = new ExecutionOwnershipBackoff({
      logger: { warn: vi.fn(), error: vi.fn() },
      now: () => 0,
    });
    backoff.observeConflict("sess-1", new Date(60_000).toISOString());
    const { runner, dispatcher } = makeRunnerProcessRuntime([]);
    dispatcher.prepareExecutionIdentity = vi.fn();
    const executor = new TaskExecutor(
      () => makeFakeEngine([]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backoff,
    );

    await expect(executor.recoverRunnerExecution(
      makeTask(),
      agent,
      runner,
      "execute-old",
      "adopt",
      "release-old",
      "env-old",
    )).rejects.toThrow("Execution ownership conflict");

    expect(dispatcher.prepareExecutionIdentity).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("실행이 끝나면 성공이든 소유권 거부든 execution slot을 비운다", async () => {
    // Recovery, intervention routing and auto-resume all read a present
    // `executionPromise` as "an execution is in flight". A settled one left
    // behind refused the offline replay of a finished turn for three hours
    // (260822) and turned every later message into a queue-only intervention.
    const mocks = makeMocks();
    const { runner } = makeRunnerProcessRuntime([]);
    const executor = new TaskExecutor(
      () => makeFakeEngine([]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecutionWithRunner(task, agent, runner);
    expect(task.executionPromise).toBeDefined();
    await task.executionPromise;
    expect(task.executionPromise).toBeUndefined();

    // The ownership rejection path is the one that mattered: it returns early
    // on purpose so durable delivery recovery can take over, so nothing
    // finalizes the task and nothing else would clear the slot.
    const rejectingMocks = makeMocks();
    Object.assign(rejectingMocks.persistence, {
      acquireExecutionOwnershipAndWaitForApplication: vi.fn(),
    });
    const backoff = new ExecutionOwnershipBackoff({
      logger: { warn: vi.fn(), error: vi.fn() },
      now: () => 0,
    });
    backoff.observeConflict("sess-1", new Date(60_000).toISOString());
    const rejectingExecutor = new TaskExecutor(
      () => makeFakeEngine([]),
      rejectingMocks.db,
      rejectingMocks.persistence,
      rejectingMocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backoff,
    );
    const rejectedTask = makeTask();
    await rejectingExecutor.startExecution(rejectedTask, agent);
    expect(rejectedTask.executionPromise).toBeUndefined();
  });

  it("adopt recovery는 sessions owner token으로 exact reconnect acquire한다", async () => {
    const mocks = makeMocks();
    const transition = (status: "running" | "completed") => ({
      eventId: status === "running" ? 21 : 22,
      applied: true,
      canonicalSession: {
        status,
        termination_reason: status === "completed" ? "completed_ok" : null,
        termination_detail: null,
        review_state: "not_required",
        last_assistant_text: null,
        termination_event_id: status === "completed" ? 22 : null,
        updated_at: "2026-08-18T00:00:00.000Z",
        last_event_id: status === "completed" ? 22 : null,
      },
    });
    const acquire = vi.fn(async () => ({
      ...transition("running"),
      canonicalExecutionOwnership: {
        ownershipGeneration: 7,
        ownerKind: "adopted_runner",
        manifestId: "release-old",
        runtimeEnvIdentity: "env-old",
        registrationId: "old-registration",
        pid: 654,
        startIdentity: "old-start",
        executionCommandId: "execute-old",
        phase: "active",
        failureReason: null,
      },
    }));
    const terminal = vi.fn(async () => transition("completed"));
    Object.assign(mocks.persistence, {
      acquireExecutionOwnershipAndWaitForApplication: acquire,
      releaseExecutionOwnershipAndWaitForApplication: terminal,
    });
    const { runner, dispatcher } = makeRunnerProcessRuntime([
      { type: "complete", result: "adopted", timestamp: 1 },
    ]);
    const proof = {
      registrationId: "old-registration",
      pid: 654,
      startIdentity: "old-start",
      executionCommandId: "execute-old",
    };
    dispatcher.prepareExecutionIdentity = vi.fn(async () => proof);
    mocks.getSession.mockResolvedValue({
      execution_generation: 7,
      execution_manifest_id: "release-old",
      execution_runtime_env_identity: "env-old",
      execution_registration_id: proof.registrationId,
      execution_pid: proof.pid,
      execution_start_identity: proof.startIdentity,
      execution_command_id: proof.executionCommandId,
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine([]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const task = makeTask();

    await executor.recoverRunnerExecution(
      task,
      agent,
      runner,
      proof.executionCommandId,
      "adopt",
      "release-old",
      "env-old",
    );

    expect(dispatcher.prepareExecutionIdentity).toHaveBeenCalledWith(
      proof.executionCommandId,
    );
    expect(acquire).toHaveBeenCalledWith(task.agentSessionId, expect.objectContaining({
      ownerKind: "adopted_runner",
      manifestId: "release-old",
      runtimeEnvIdentity: "env-old",
      ...proof,
    }));
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(
      dispatcher.recoverFrames.mock.invocationCallOrder[0]!,
    );
    expect(terminal).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({ type: "session_ended" }),
      expect.objectContaining({
        ownershipGeneration: 7,
        executionCommandId: proof.executionCommandId,
      }),
    );
    expect(task.executionOwnership).toBeUndefined();
  });

  it("adopt reconnect rejection detaches the dormant identity before input", async () => {
    const mocks = makeMocks();
    const transition = {
      eventId: 20,
      applied: true,
      canonicalSession: {
        status: "initializing",
        termination_reason: null,
        termination_detail: null,
        review_state: "not_required",
        last_assistant_text: null,
        termination_event_id: null,
        updated_at: "2026-08-19T00:00:00.000Z",
        last_event_id: 20,
      },
    };
    Object.assign(mocks.persistence, {
      acquireExecutionOwnershipAndWaitForApplication: vi.fn(async () => ({
        ...transition,
        applied: false,
        canonicalExecutionOwnership: null,
      })),
    });
    const { runner, dispatcher } = makeRunnerProcessRuntime([]);
    const proof = {
      registrationId: "old-registration",
      pid: 654,
      startIdentity: "old-start",
      executionCommandId: "execute-old",
    };
    dispatcher.prepareExecutionIdentity = vi.fn(async () => proof);
    dispatcher.rollbackExecutionIdentity = vi.fn(async () => {});
    mocks.getSession.mockResolvedValue({
      execution_generation: 7,
      execution_manifest_id: "release-old",
      execution_runtime_env_identity: "env-old",
      execution_registration_id: proof.registrationId,
      execution_pid: proof.pid,
      execution_start_identity: proof.startIdentity,
      execution_command_id: proof.executionCommandId,
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine([]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();

    await expect(executor.recoverRunnerExecution(
      task,
      agent,
      runner,
      proof.executionCommandId,
      "adopt",
      "release-old",
      "env-old",
    )).rejects.toThrow("Execution ownership conflict");

    expect(dispatcher.rollbackExecutionIdentity).toHaveBeenCalledWith(proof);
    expect(dispatcher.recoverFrames).not.toHaveBeenCalled();
    expect(task.runner).toBeUndefined();
  });

  it("replays an adopted execution through the same event publisher and ACK boundary", async () => {
    const mocks = makeMocks();
    let releaseRunningTransition!: () => void;
    mocks.enqueueRunningTransitionAndWaitForApplication.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseRunningTransition = () => resolve({
          eventId: 101,
          applied: true,
          canonicalSession: {
            status: "running",
            termination_reason: null,
            termination_detail: null,
            review_state: "not_required",
            last_assistant_text: null,
            termination_event_id: null,
            updated_at: "2026-08-11T00:00:00.000Z",
            last_event_id: 101,
          },
        });
      }),
    );
    const { runner, dispatcher } = makeRunnerProcessRuntime([
      { type: "assistant_message", content: "replayed" },
      { type: "complete", result: "done", timestamp: 1 },
    ]);
    const executor = new TaskExecutor(
      () => makeFakeEngine([]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();

    const recovery = executor.recoverRunnerExecution(task, agent, runner, "execute-old");

    await vi.waitFor(() => expect(
      mocks.enqueueRunningTransitionAndWaitForApplication,
    ).toHaveBeenCalledWith(
      task.agentSessionId,
      {
        reviewState: "not_required",
        transitionId: "adopt:execute-old",
      },
    ));
    expect(dispatcher.recoverFrames).toHaveBeenCalledWith("execute-old");
    expect(dispatcher.waitForSessionAck).not.toHaveBeenCalled();
    expect(task.lastAssistantText).toBeUndefined();

    releaseRunningTransition();
    await recovery;

    expect(dispatcher.prepareSession).not.toHaveBeenCalled();
    expect(dispatcher.waitForSessionAck).toHaveBeenCalled();
    expect(task.lastEventId).toBeGreaterThan(0);
    expect(task.lastAssistantText).toBe("replayed");
    expect(task.status).toBe("completed");
  });

  it("propagates an adopted runner transport failure after finalizing the failed execution", async () => {
    const mocks = makeMocks();
    const socketError = new Error("Runner socket unavailable after 10000ms deadline", {
      cause: Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }),
    });
    const { runner, dispatcher } = makeRunnerProcessRuntime([]);
    dispatcher.recoverFrames.mockReturnValue((async function* () {
      throw socketError;
    })());
    const executor = new TaskExecutor(
      () => makeFakeEngine([]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();

    await expect(executor.recoverRunnerExecution(
      task,
      agent,
      runner,
      "execute-old",
      "adopt",
    )).rejects.toBe(socketError);

    expect(task.status).toBe("error");
    expect(task.error).toBe("Runner socket unavailable after 10000ms deadline");
    expect(dispatcher.close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "success",
      events: [{ type: "complete", result: "recovered" }] as SSEEventPayload[],
      expectedStatus: "completed" as const,
      expectedAttempts: 0,
    },
    {
      label: "prompt-too-long refail",
      events: [{
        type: "error",
        message: "Prompt is too long after runner restart",
        fatal: false,
        error_code: "claude_prompt_too_long",
      }] as SSEEventPayload[],
      expectedStatus: "error" as const,
      expectedAttempts: 1,
    },
  ])(
    "recovered runner rollover cycle resolves $label without opening a second replay",
    async ({ events, expectedStatus, expectedAttempts }) => {
      const mocks = makeMocks();
      const { runner } = makeRunnerProcessRuntime(events);
      const executor = new TaskExecutor(
        () => makeFakeEngine([]),
        mocks.db,
        mocks.persistence,
        mocks.broadcaster,
        silentLogger,
      );
      const task = makeTask();
      task.profileId = claudeAgent.id;
      task.codexThreadId = "claude-fresh";
      task.claudeBackendRolloverAttempts = 1;
      task.claudeBackendRolloverCycleFrom = "claude-over-limit";

      await executor.recoverRunnerExecution(
        task,
        claudeAgent,
        runner,
        "execute-rollover",
      );

      expect(task.status).toBe(expectedStatus);
      expect(task.claudeBackendRolloverAttempts).toBe(expectedAttempts);
      expect(task.claudeBackendRolloverCycleFrom).toBe(
        expectedAttempts === 0 ? undefined : "claude-over-limit",
      );
      expect(mocks.enqueueMetadataEffect).toHaveBeenCalledTimes(
        expectedAttempts === 0 ? 1 : 0,
      );
    },
  );

  it.each([
    { backend: "claude" as const, profile: claudeAgent },
    { backend: "codex" as const, profile: agent },
  ])(
    "$backend restart → adopt → queued intervention → follow-up turn completes",
    async ({ backend, profile }) => {
      const mocks = makeMocks();
      const recovered = deferred<void>();
      const finishRecoveredTurn = deferred<void>();
      const followupInputs: EngineExecuteParams[] = [];
      const dispatcher = {
        dispatch: vi.fn(),
        executeFrames: vi.fn((params: EngineExecuteParams) => {
          followupInputs.push(params);
          return frameStream([
            { type: "assistant_message", content: `${backend} follow-up complete` },
            { type: "complete", result: "done", timestamp: 3 },
          ]);
        }),
        recoverFrames: vi.fn(() => (async function* () {
          recovered.resolve();
          await finishRecoveredTurn.promise;
          yield engineEventFrame({ type: "complete", result: "recovered", timestamp: 2 });
        })()),
        prepareSession: vi.fn(async () => {}),
        interrupt: vi.fn(async () => true),
        close: vi.fn(async () => {}),
        detachHost: vi.fn(async () => {}),
        sendControlFrame: vi.fn(async () => true),
        requestContext: vi.fn(),
        waitForSessionAck: vi.fn(async () => 12),
        recoverPendingInterventions: vi.fn(async () => [{
          interventionId: `intervention-${backend}`,
          message: {
            text: `post-recovery ${backend} intervention`,
            user: "soak",
          },
        }]),
        invoke: vi.fn(),
      };
      const runner: TaskRunnerRuntime = {
        engine: new RunnerProcessEngineProxy(
          backend,
          profile.workspace_dir,
          dispatcher as never,
        ),
        dispatcher: dispatcher as never,
        eventPersistence: "runner",
      };
      const executor = new TaskExecutor(
        () => makeFakeEngine([]),
        mocks.db,
        mocks.persistence,
        mocks.broadcaster,
        silentLogger,
      );
      const task = makeTask();
      task.profileId = profile.id;

      const recovery = executor.recoverRunnerExecution(
        task,
        profile,
        runner,
        `execute-${backend}`,
      );
      await recovered.promise;
      finishRecoveredTurn.resolve();
      await recovery;

      expect(followupInputs).toHaveLength(1);
      expect(followupInputs[0]).toMatchObject({
        prompt: `post-recovery ${backend} intervention`,
        runnerInterventionId: `intervention-${backend}`,
      });
      expect(dispatcher.recoverPendingInterventions).toHaveBeenCalledTimes(1);
      expect(task.status).toBe("completed");
      expect(task.lastAssistantText).toBe(`${backend} follow-up complete`);
    },
  );
});

function makeRunnerProcessRuntime(events: SSEEventPayload[]): {
  runner: TaskRunnerRuntime;
  dispatcher: Record<string, ReturnType<typeof vi.fn>>;
} {
  const dispatcher = {
    dispatch: vi.fn(),
    executeFrames: vi.fn(() => frameStream(events)),
    recoverFrames: vi.fn(() => frameStream(events)),
    prepareExecutionIdentity: vi.fn(async () => ({
      registrationId: "registration-1",
      pid: 321,
      startIdentity: "start-1",
      executionCommandId: "execute-1",
    })),
    prepareSession: vi.fn(async () => {}),
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    detachHost: vi.fn(async () => {}),
    releaseEventStreamRegistration: vi.fn(async () => {}),
    sendControlFrame: vi.fn(async () => true),
    requestContext: vi.fn(),
    waitForSessionAck: vi.fn(async () => 12),
    invoke: vi.fn(),
  };
  return {
    runner: {
      engine: makeFakeEngine([]),
      dispatcher: dispatcher as never,
      eventPersistence: "runner",
    },
    dispatcher,
  };
}

async function* frameStream(events: SSEEventPayload[]) {
  for (const event of events) yield engineEventFrame(event);
}

describe("isTerminalStatus", () => {
  it("completed/error/interrupted는 terminal", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("error")).toBe(true);
    expect(isTerminalStatus("interrupted")).toBe(true);
  });
  it("running은 non-terminal", () => {
    expect(isTerminalStatus("running")).toBe(false);
  });
});

describe("TaskExecutor multi-turn (B-4)", () => {
  it("Claude queued fallback intervention은 다음 turn으로 처리한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;

    const started = deferred<void>();
    const release = deferred<void>();
    const captured: Array<{
      prompt: string;
      resumeSessionId: string | undefined;
      hasOnIntervention: boolean;
    }> = [];
    let executeCalls = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        executeCalls += 1;
        captured.push({
          prompt: params.prompt,
          resumeSessionId: params.resumeSessionId,
          hasOnIntervention: typeof params.onIntervention === "function",
        });
        if (executeCalls === 1) {
          yield { type: "session", session_id: "claude-sess-1" } as SSEEventPayload;
          started.resolve();
          await release.promise;
          yield { type: "text_delta", text: "first turn", timestamp: 2 } as SSEEventPayload;
          yield { type: "complete", result: "done", timestamp: 3 } as SSEEventPayload;
          return;
        }
        yield { type: "session", session_id: "claude-sess-1" } as SSEEventPayload;
        yield { type: "complete", result: "done", timestamp: 4 } as SSEEventPayload;
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
    );

    executor.startExecution(task, claudeAgent);
    await started.promise;
    task.interventionQueue.push({
      text: "지금 반영",
      user: "alice",
      attachmentPaths: ["/tmp/incoming/sess/readme.txt"],
    });
    release.resolve();
    await task.executionPromise;

    expect(executeCalls).toBe(2);
    expect(captured[0]).toEqual({ prompt: "hi", resumeSessionId: undefined, hasOnIntervention: false });
    expect(captured[1]).toMatchObject({
      resumeSessionId: "claude-sess-1",
      hasOnIntervention: false,
    });
    expect(captured[1].prompt).toContain("/tmp/incoming/sess/readme.txt");
    expect(captured[1].prompt).toContain(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/readme.txt]",
    );
    expect(captured[1].prompt.endsWith(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/readme.txt]",
    )).toBe(true);
    expect(task.interventionQueue).toHaveLength(0);
    expect(task.status).toBe("completed");
  });

  it("Claude running intervention 이미지 첨부도 다음 turn의 imageAttachmentPaths로 분리한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;

    const started = deferred<void>();
    const release = deferred<void>();
    const captured: Array<{
      prompt: string;
      imageAttachmentPaths: string[] | undefined;
      hasOnIntervention: boolean;
    }> = [];
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        captured.push({
          prompt: params.prompt,
          imageAttachmentPaths: params.imageAttachmentPaths,
          hasOnIntervention: typeof params.onIntervention === "function",
        });
        if (captured.length === 1) {
          yield { type: "session", session_id: "claude-sess-1" } as SSEEventPayload;
          started.resolve();
          await release.promise;
          yield { type: "complete", result: "done", timestamp: 1 } as SSEEventPayload;
          return;
        }
        yield { type: "session", session_id: "claude-sess-1" } as SSEEventPayload;
        yield { type: "complete", result: "done", timestamp: 2 } as SSEEventPayload;
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
    );

    executor.startExecution(task, claudeAgent);
    await started.promise;
    task.interventionQueue.push({
      text: "이 이미지 봐줘",
      user: "alice",
      attachmentPaths: ["/tmp/incoming/sess/a.png", "/tmp/incoming/sess/readme.txt"],
    });
    release.resolve();
    await task.executionPromise;

    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      prompt: "hi",
      imageAttachmentPaths: [],
      hasOnIntervention: false,
    });
    expect(captured[1]).toMatchObject({
      imageAttachmentPaths: ["/tmp/incoming/sess/a.png"],
      hasOnIntervention: false,
    });
    expect(captured[1].prompt).toContain(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/a.png]",
    );
    expect(captured[1].prompt).toContain(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/readme.txt]",
    );
    expect(captured[1].prompt).toContain("/tmp/incoming/sess/readme.txt");
    expect(captured[1].prompt.endsWith(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/readme.txt]",
    )).toBe(true);
  });

  it("Claude intervention 후속 턴에는 첫 turn systemPrompt를 SDK 옵션으로 다시 전달하지 않는다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    const capturedSystemPrompts: Array<string | undefined> = [];
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedSystemPrompts.push(params.systemPrompt);
        if (turnCount === 0) {
          turnCount += 1;
          yield { type: "session", session_id: "claude-sess-1" } as SSEEventPayload;
          task.interventionQueue.push({ text: "follow up", user: "u" });
          yield { type: "complete", result: "first done", timestamp: 1 } as SSEEventPayload;
          return;
        }
        turnCount += 1;
        yield { type: "complete", result: "second done", timestamp: 2 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const fakeBuilder = {
      build: vi.fn(async () => ({
        effectiveSystemPrompt: "folder prompt\n\nagent prompt",
        combinedContextItems: [],
        assembledPrompt: "hi",
      })),
      buildFollowupContext: vi.fn(async () => ({
        contextItems: [
          {
            key: "running_sessions",
            label: "Running Sessions",
            content: { status: "ok", sessions: [] },
          },
        ],
      })),
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(capturedSystemPrompts).toEqual([
      "folder prompt\n\nagent prompt",
      undefined,
    ]);
    expect(fakeBuilder.buildFollowupContext).toHaveBeenCalledWith(
      task,
      claudeAgent,
      expect.objectContaining({ includeFullContext: false }),
    );
  });

  it("Codex execute params에는 onIntervention을 넘기지 않아 turn 사이 큐잉 semantics를 보존한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    let turnCount = 0;
    const onInterventionFlags: boolean[] = [];
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        onInterventionFlags.push(typeof params.onIntervention === "function");
        if (turnCount === 0) {
          turnCount += 1;
          yield { type: "session", session_id: "thr-1" } as SSEEventPayload;
          task.interventionQueue.push({ text: "queued for next turn", user: "u" });
          yield { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload;
          return;
        }
        turnCount += 1;
        yield { type: "complete", usage: {}, timestamp: 2 } as SSEEventPayload;
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
    );

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(turnCount).toBe(2);
    expect(onInterventionFlags).toEqual([false, false]);
    expect(task.interventionQueue).toHaveLength(0);
  });

  it("turn 종료 시 interventionQueue 비어있지 않으면 다음 turn 자동 시작 (resume)", async () => {
    // turn 1: session(thr-1) + text_delta("a") + text_end + complete
    // turn 종료 후 task.interventionQueue.push({text:"continue"}) — 외부 큐잉 시뮬레이션
    // turn 2: text_delta("b") + text_end + complete
    // 결과 status="completed", 두 turn 모두 drain
    const mocks = makeMocks();
    const turn1: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_delta", text: "a", timestamp: 1 } as SSEEventPayload,
      { type: "text_end", timestamp: 1 } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const turn2: SSEEventPayload[] = [
      { type: "text_delta", text: "b", timestamp: 2 } as SSEEventPayload,
      { type: "text_end", timestamp: 2 } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 2 } as SSEEventPayload,
    ];
    let turnCount = 0;
    const captured: { turn: number; resumeSessionId: string | undefined }[] = [];

    const task = makeTask();
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      // eslint-disable-next-line require-yield
      async *execute(params): AsyncIterable<SSEEventPayload> {
        captured.push({
          turn: turnCount,
          resumeSessionId: params?.resumeSessionId,
        });
        const events = turnCount === 0 ? turn1 : turn2;
        turnCount += 1;
        // turn 1 첫 이벤트(session) 처리 후 외부에서 큐 push를 시뮬레이션:
        // turn 1 drain이 끝나기 전에 마지막 이벤트 직후 push (concurrent 시뮬레이션 어렵지만,
        // 본 테스트는 *turn 종료 시 queue 확인* 흐름이 정합인지 보는 것이라 yield 이전 push로 등가).
        if (turnCount === 1) {
          // turn 1 끝나기 전에 queue에 push (외부 intervene이 들어왔다고 가정)
          task.interventionQueue.push({ text: "continue", user: "u" });
        }
        for (const ev of events) {
          yield ev;
        }
      },
      async interrupt() { return true; },
      async close() {},
    };
    const factory = vi.fn(() => engine);
    const executor = new TaskExecutor(factory, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(turnCount).toBe(2);
    expect(captured[0].resumeSessionId).toBeUndefined();
    // 두 번째 turn은 첫 turn에서 박힌 codexThreadId로 resume
    expect(captured[1].resumeSessionId).toBe("thr-1");
    expect(task.status).toBe("completed");
    expect(task.interventionQueue).toHaveLength(0);
  });

  it("intervention queued during turn still resumes when runtime task lingers without non-idle session state", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    const capturedPrompts: string[] = [];
    let turnCount = 0;

    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedPrompts.push(params.prompt);
        turnCount += 1;
        if (turnCount === 1) {
          yield { type: "session", session_id: "claude-sess-intervention" } as SSEEventPayload;
          task.interventionQueue.push({ text: "correct this while running", user: "u" });
          yield {
            type: "claude_runtime_task_started",
            task_id: "lingering-runtime-task",
            task_type: "local_agent",
            description: "runtime task started before intervention",
          } as SSEEventPayload;
          yield { type: "complete", result: "first turn", timestamp: 1 } as SSEEventPayload;
          return;
        }
        yield { type: "complete", result: "second turn", timestamp: 2 } as SSEEventPayload;
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
    );
    task.profileId = claudeAgent.id;

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turnCount).toBe(2);
    expect(capturedPrompts[1]).toBe("correct this while running");
    expect(task.status).toBe("completed");
    expect(task.interventionQueue).toHaveLength(0);
    expect(task.claudeRuntime).toMatchObject({
      tasks: {
        "lingering-runtime-task": {
          status: "running",
        },
      },
    });
    const pendingAfterTurnError = mocks.persistEvent.mock.calls.find(
      (call) =>
        (call[1] as { error_code?: string }).error_code ===
        "claude_runtime_pending_after_turn",
    );
    expect(pendingAfterTurnError).toBeUndefined();
  });

  it("intervention queued during turn resumes after runtime session returns to idle", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    let turnCount = 0;

    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        turnCount += 1;
        if (turnCount === 1) {
          task.interventionQueue.push({ text: "resume after idle", user: "u" });
          yield {
            type: "claude_runtime_session_state",
            state: "running",
            session_id: "claude-sess-idle-after-intervention",
          } as SSEEventPayload;
          yield {
            type: "claude_runtime_session_state",
            state: "idle",
            session_id: "claude-sess-idle-after-intervention",
          } as SSEEventPayload;
          yield { type: "complete", result: "first turn", timestamp: 1 } as SSEEventPayload;
          return;
        }
        yield { type: "complete", result: "second turn", timestamp: 2 } as SSEEventPayload;
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
    );
    task.profileId = claudeAgent.id;

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turnCount).toBe(2);
    expect(task.status).toBe("completed");
    expect(task.interventionQueue).toHaveLength(0);
    expect(task.claudeRuntime?.sessionState).toBe("idle");
    const pendingAfterTurnError = mocks.persistEvent.mock.calls.find(
      (call) =>
        (call[1] as { error_code?: string }).error_code ===
        "claude_runtime_pending_after_turn",
    );
    expect(pendingAfterTurnError).toBeUndefined();
  });

  it("P1-3: owner 증거 없는 queued input과 진짜 crash는 error로 분류하고 보존", async () => {
    const mocks = makeMocks();
    const task = makeTask();

    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(): AsyncIterable<SSEEventPayload> {
        // 첫 yield 후 외부 intervention 도착 시뮬레이션
        yield { type: "session", session_id: "thr-1" } as SSEEventPayload;
        task.interventionQueue.push({ text: "pending", user: "u" });
        throw new Error("engine boom");
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("error");
    expect(task.pendingTerminationHint).toBe("error_aborted");
    expect(task.interventionQueue).toEqual([{ text: "pending", user: "u" }]);
    const skippedBroadcast = mocks.emitEventEnvelope.mock.calls.find(
      (c) => /queued intervention\(s\) skipped/.test(
        String((c[1] as { message?: string }).message),
      ),
    );
    expect(skippedBroadcast).toBeUndefined();
  });

  it("accepted successor owner가 있으면 failed old turn 뒤 같은 execution에서 대화를 계속한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    let turnCount = 0;

    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        turnCount += 1;
        if (turnCount === 1) {
          yield { type: "session", session_id: "thr-1" } as SSEEventPayload;
          task.interventionQueue.push({
            text: "correct the active work",
            user: "u",
            deliveryId: "delivery-successor-1",
            runnerInterventionId: "delivery-successor-1",
          });
          throw new Error("aborted_streaming: read ECONNRESET");
        }
        expect(params.runnerInterventionId).toBe("delivery-successor-1");
        yield {
          type: "complete",
          result: "continued in the same execution",
          timestamp: 2,
        } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const factory = vi.fn(() => engine);
    const executor = new TaskExecutor(
      factory,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(factory).toHaveBeenCalledTimes(1);
    expect(turnCount).toBe(2);
    expect(task.status).toBe("completed");
    expect(task.error).toBeUndefined();
    expect(task.pendingTerminationHint).toBeUndefined();
    expect(task.interventionQueue).toHaveLength(0);
  });

  it("큐의 세 delivery를 순서대로 한 model turn에 넣고 각각 한 번 consume한다", async () => {
    const mocks = makeMocks();
    const executeInputs: EngineExecuteParams[] = [];
    const deliveryRecorder = {
      recordTurnStarted: vi.fn().mockResolvedValue(undefined),
      recordConsumed: vi.fn().mockResolvedValue(undefined),
    };
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        executeInputs.push(params);
        yield { type: "assistant_message", content: "all heard", timestamp: 1 } as unknown as SSEEventPayload;
        yield { type: "complete", result: "done", timestamp: 2 } as SSEEventPayload;
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
      undefined,
      deliveryRecorder,
    );
    const task = makeTask();
    const messages: InterventionMessage[] = [
      {
        text: "first correction",
        user: "u",
        deliveryId: "61000000-0000-4000-8000-000000000001",
        runnerInterventionId: "runner-intervention-1",
        deliveryIntent: "human_live_steer",
      },
      {
        text: "second correction",
        user: "u",
        deliveryId: "61000000-0000-4000-8000-000000000002",
        runnerInterventionId: "runner-intervention-2",
        deliveryIntent: "human_live_steer",
      },
      {
        text: "third correction",
        user: "u",
        deliveryId: "61000000-0000-4000-8000-000000000003",
        runnerInterventionId: "runner-intervention-3",
        deliveryIntent: "human_live_steer",
      },
    ];
    task.interventionQueue.push(...messages);

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(executeInputs).toHaveLength(1);
    expect(executeInputs[0]!.prompt.indexOf("first correction")).toBeLessThan(
      executeInputs[0]!.prompt.indexOf("second correction"),
    );
    expect(executeInputs[0]!.prompt.indexOf("second correction")).toBeLessThan(
      executeInputs[0]!.prompt.indexOf("third correction"),
    );
    for (const message of messages) {
      expect(executeInputs[0]!.prompt.split(message.text)).toHaveLength(2);
    }
    expect((executeInputs[0] as EngineExecuteParams & {
      runnerInterventionIds?: string[];
    }).runnerInterventionIds).toEqual([
      "runner-intervention-1",
      "runner-intervention-2",
      "runner-intervention-3",
    ]);
    expect(deliveryRecorder.recordTurnStarted).toHaveBeenCalledTimes(3);
    for (const message of messages) {
      expect(deliveryRecorder.recordTurnStarted).toHaveBeenCalledWith(message, task);
      expect(deliveryRecorder.recordConsumed).toHaveBeenCalledWith(
        message,
        task,
        expect.stringMatching(/^event:/),
      );
    }
    expect(deliveryRecorder.recordConsumed).toHaveBeenCalledTimes(3);
    expect(task.status).toBe("completed");
    expect(task.interventionQueue).toEqual([]);
  });

  it("turn 종료 시 interventionQueue 비어있으면 status=completed로 종료 (단일 turn 회귀)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-x" } as SSEEventPayload,
      { type: "text_end", timestamp: 1 } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const factory = vi.fn(() => makeFakeEngine(events));
    const executor = new TaskExecutor(factory, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;
    expect(task.status).toBe("completed");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("terminal auto-resume은 기존 claude_session_id를 resumeSessionId로 쓰고 새 session 이벤트로 덮어쓰지 않는다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.codexThreadId = "claude-existing";
    task.interventionQueue.push({ text: "resume", user: "u" });
    const capturedResumeIds: Array<string | undefined> = [];
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedResumeIds.push(params.resumeSessionId);
        yield { type: "session", session_id: "claude-new-should-not-overwrite" } as SSEEventPayload;
        yield { type: "complete", result: "done", timestamp: 1 } as SSEEventPayload;
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
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(capturedResumeIds).toEqual(["claude-existing"]);
    expect(task.codexThreadId).toBe("claude-existing");
    expect(mocks.setClaudeSessionId).not.toHaveBeenCalledWith(
      "sess-1",
      "claude-new-should-not-overwrite",
    );
  });

  it("terminal auto-resume Claude turn은 full context/systemPrompt를 다시 전달하지 않는다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.codexThreadId = "claude-existing";
    task.lastInjectedClaudeSessionId = "claude-existing";
    task.interventionQueue.push({ text: "resume", user: "u" });
    const capturedSystemPrompts: Array<string | undefined> = [];
    const capturedPrompts: string[] = [];
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedSystemPrompts.push(params.systemPrompt);
        capturedPrompts.push(params.prompt);
        yield { type: "complete", result: "done", timestamp: 1 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const fakeBuilder = {
      build: vi.fn(async () => ({
        effectiveSystemPrompt: "resume system prompt",
        combinedContextItems: [],
        assembledPrompt: "unused",
      })),
      buildSystemPrompt: vi.fn(async () => "resume system prompt"),
      buildFollowupContext: vi.fn(async () => ({
        contextItems: [
          {
            key: "running_sessions",
            label: "Running Sessions",
            content: { status: "ok", sessions: [] },
          },
        ],
      })),
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(fakeBuilder.build).not.toHaveBeenCalled();
    expect(fakeBuilder.buildSystemPrompt).not.toHaveBeenCalled();
    expect(fakeBuilder.buildFollowupContext).toHaveBeenCalledWith(
      task,
      claudeAgent,
      expect.objectContaining({
        includeFullContext: false,
        includeClaudeSessionIdUpdate: false,
      }),
    );
    expect(capturedSystemPrompts).toEqual([undefined]);
    expect(capturedPrompts[0]).toContain("resume");
    expect(capturedPrompts[0]).toContain("<running_sessions>");
  });

  it("prompt_too_long은 backend session을 한 번 rollover하고 같은 입력을 full context로 한 번 replay한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.codexThreadId = "claude-over-limit";
    task.interventionQueue.push({ text: "resume this work", user: "u" });
    const captured: EngineExecuteParams[] = [];
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        captured.push(params);
        if (captured.length === 1) {
          yield {
            type: "result",
            success: false,
            output: "Prompt is too long",
            terminal_reason: "prompt_too_long",
          } as SSEEventPayload;
          yield {
            type: "error",
            message: "Prompt is too long",
            fatal: false,
            error_code: "claude_prompt_too_long",
          } as SSEEventPayload;
          return;
        }
        yield { type: "session", session_id: "claude-fresh" } as SSEEventPayload;
        yield { type: "complete", result: "recovered" } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const fakeBuilder = {
      build: vi.fn(),
      buildFollowupContext: vi.fn(async (_task, _agent, options) => ({
        effectiveSystemPrompt: options.includeFullContext
          ? "full system after rollover"
          : undefined,
        contextItems: options.includeFullContext
          ? [{ key: "soulstream_session", label: "Soulstream", content: { restored: true } }]
          : [],
      })),
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      prompt: "resume this work",
      resumeSessionId: "claude-over-limit",
    });
    expect(captured[1]).toMatchObject({
      prompt: expect.stringContaining("resume this work"),
      systemPrompt: "full system after rollover",
      backendSessionRolloverFrom: "claude-over-limit",
    });
    expect(captured[1]).not.toHaveProperty("resumeSessionId");
    expect(captured[1]?.prompt).toContain("<soulstream_session>");
    expect(mocks.enqueueMetadataEffect).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({
        type: "claude_backend_rollover",
        value: expect.objectContaining({ attempts: 1, reason: "prompt_too_long" }),
      }),
      expect.objectContaining({
        replaceExistingType: "claude_backend_rollover",
        waitForAck: true,
      }),
    );
    expect(mocks.persistEvent).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({ type: "session", session_id: "claude-fresh" }),
      {
        kind: "rotate_backend_session_id",
        expected_backend_session_id: "claude-over-limit",
        backend_session_id: "claude-fresh",
      },
      1,
    );
    expect(task.codexThreadId).toBe("claude-fresh");
    expect(task.status).toBe("completed");
  });

  it("직전 84% usage에 다음 대형 turn input 추정치를 더해 실행 전에 compact한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.codexThreadId = "claude-large-jump";
    const compact = vi.fn().mockResolvedValue(undefined);
    const captured: EngineExecuteParams[] = [];
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        captured.push(params);
        if (captured.length === 1) {
          task.interventionQueue.push({ text: "x".repeat(60_000), user: "u" });
          yield {
            type: "context_usage",
            used_tokens: 840_000,
            max_tokens: 1_000_000,
            percent: 84,
          } as SSEEventPayload;
        }
        yield { type: "complete", result: "done" } as SSEEventPayload;
      },
      compact,
      async interrupt() { return true; },
      async close() {},
    };
    const fakeBuilder = {
      build: vi.fn(async () => ({ combinedContextItems: [], assembledPrompt: task.prompt })),
      buildFollowupContext: vi.fn(async () => ({ contextItems: [] })),
      buildBackendRolloverContext: vi.fn(async () => ({
        contextItems: [],
        currentSessionExcerpt: { totalEvents: 0, turns: [] },
      })),
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(captured).toHaveLength(2);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith("claude-large-jump");
    expect(task.status).toBe("completed");
  });

  it.each(["in-process", "runner"] as const)(
    "%s: over-limit → boundary 없는 compact 실패 → prompt_too_long → rollover → replay 1회 → 생존",
    async (mode) => {
      const mocks = makeMocks();
      const task = makeTask();
      task.profileId = claudeAgent.id;
      task.codexThreadId = "claude-over-limit";
      const compact = vi.fn().mockRejectedValue(new Error("compact boundary not observed"));
      const captured: EngineExecuteParams[] = [];
      const eventsForTurn = (params: EngineExecuteParams): SSEEventPayload[] => {
        captured.push(params);
        if (captured.length === 1) {
          task.interventionQueue.push({ text: "x".repeat(24_000), user: "u" });
          return [
            {
              type: "context_usage",
              used_tokens: 164_000,
              max_tokens: 200_000,
              percent: 82,
            } as SSEEventPayload,
            { type: "complete", result: "before jump" } as SSEEventPayload,
          ];
        }
        if (captured.length === 2) {
          return [
            {
              type: "result",
              success: false,
              output: "Prompt is too long",
              terminal_reason: "prompt_too_long",
            } as SSEEventPayload,
            {
              type: "error",
              message: "Prompt is too long",
              fatal: false,
              error_code: "claude_prompt_too_long",
            } as SSEEventPayload,
          ];
        }
        return [
          { type: "session", session_id: "claude-fresh" } as SSEEventPayload,
          { type: "complete", result: "recovered" } as SSEEventPayload,
        ];
      };
      const engine: EnginePort = {
        backendId: "claude",
        workspaceDir: "/tmp/claude-roselin",
        async *execute(params): AsyncIterable<SSEEventPayload> {
          for (const event of eventsForTurn(params)) yield event;
        },
        compact,
        async interrupt() { return true; },
        async close() {},
      };
      const fakeBuilder = {
        build: vi.fn(async () => ({ combinedContextItems: [], assembledPrompt: task.prompt })),
        buildFollowupContext: vi.fn(async () => ({ contextItems: [] })),
        buildBackendRolloverContext: vi.fn(async () => ({
          effectiveSystemPrompt: "fresh system",
          contextItems: [],
          currentSessionExcerpt: {
            totalEvents: 100,
            turns: [{
              event_id: 99,
              event_type: "assistant_message",
              text: "last valid result",
              created_at: "2026-08-12T00:00:00.000Z",
            }],
          },
        })),
      };
      let processFactory: RunnerProcessRuntimeFactory | undefined;
      if (mode === "runner") {
        const { runner: baseRunner, dispatcher } = makeRunnerProcessRuntime([]);
        dispatcher.executeFrames.mockImplementation((params: EngineExecuteParams) =>
          frameStream(eventsForTurn(params))
        );
        const runner = { ...baseRunner, engine };
        processFactory = vi.fn(() => runner) as unknown as RunnerProcessRuntimeFactory;
        processFactory.describe = vi.fn(async () => ({
          ownerKind: "runner_process",
          manifestId: "release-1",
          runtimeEnvIdentity: "env-1",
        }));
      }
      const executor = new TaskExecutor(
        () => engine,
        mocks.db,
        mocks.persistence,
        mocks.broadcaster,
        silentLogger,
        fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        processFactory,
      );

      executor.startExecution(task, claudeAgent);
      await task.executionPromise;

      expect(compact).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(3);
      expect(captured[1]).toMatchObject({ resumeSessionId: "claude-over-limit" });
      expect(captured[2]).toMatchObject({
        backendSessionRolloverFrom: "claude-over-limit",
        systemPrompt: "fresh system",
      });
      expect(captured[2]).not.toHaveProperty("resumeSessionId");
      expect(captured[2]?.prompt).toContain("last valid result");
      expect(task.codexThreadId).toBe("claude-fresh");
      expect(task.status).toBe("completed");
    },
  );

  it("prompt_too_long 재실패는 rollover/replay를 반복하지 않고 fatal error로 끝낸다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.codexThreadId = "claude-over-limit";
    task.interventionQueue.push({ text: "resume once", user: "u" });
    const captured: EngineExecuteParams[] = [];
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        captured.push(params);
        if (captured.length === 2) {
          yield { type: "session", session_id: "claude-fresh" } as SSEEventPayload;
        }
        yield {
          type: "error",
          message: "Prompt is too long",
          fatal: false,
          error_code: "claude_prompt_too_long",
        } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const fakeBuilder = {
      build: vi.fn(),
      buildFollowupContext: vi.fn(async () => ({
        effectiveSystemPrompt: "full system",
        contextItems: [],
      })),
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(captured).toHaveLength(2);
    expect(task.status).toBe("error");
    expect(task.error).toContain("Prompt is too long");
    expect(mocks.enqueueMetadataEffect).toHaveBeenCalledTimes(1);
    expect(task.claudeBackendRolloverAttempts).toBe(1);
    expect(task.claudeBackendRolloverCycleFrom).toBe("claude-over-limit");
  });

  it("ACK 뒤 rotate 전 재시작한 rollover cycle을 predecessor resume 없이 이어간다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.codexThreadId = "claude-over-limit";
    task.claudeBackendRolloverAttempts = 1;
    task.claudeBackendRolloverCycleFrom = "claude-over-limit";
    task.pendingClaudeBackendRolloverFrom = "claude-over-limit";
    task.interventionQueue.push({ text: "durable failed input", user: "u" });
    const captured: EngineExecuteParams[] = [];
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        captured.push(params);
        yield { type: "session", session_id: "claude-fresh" } as SSEEventPayload;
        yield { type: "complete", result: "recovered" } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const fakeBuilder = {
      buildFollowupContext: vi.fn(async () => ({ contextItems: [] })),
      buildBackendRolloverContext: vi.fn(async () => ({ contextItems: [] })),
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      backendSessionRolloverFrom: "claude-over-limit",
    });
    expect(captured[0]).not.toHaveProperty("resumeSessionId");
    expect(task.codexThreadId).toBe("claude-fresh");
    expect(task.claudeBackendRolloverAttempts).toBe(0);
    expect(task.claudeBackendRolloverCycleFrom).toBeUndefined();
    expect(task.pendingClaudeBackendRolloverFrom).toBeUndefined();
    expect(mocks.enqueueMetadataEffect).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({
        type: "claude_backend_rollover",
        value: expect.objectContaining({
          attempts: 0,
          phase: "completed",
          previous_session_id: "claude-over-limit",
          backend_session_id: "claude-fresh",
        }),
      }),
      expect.objectContaining({ waitForAck: true }),
    );
  });

  it("backend rotate 뒤 completed metadata 전 재시작한 cycle을 정상 turn 성공으로 재무장한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.codexThreadId = "claude-fresh";
    task.claudeBackendRolloverAttempts = 1;
    task.claudeBackendRolloverCycleFrom = "claude-over-limit";
    task.interventionQueue.push({ text: "resume rotated backend", user: "u" });
    const captured: EngineExecuteParams[] = [];
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        captured.push(params);
        yield { type: "complete", result: "cycle completed" } as SSEEventPayload;
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
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ resumeSessionId: "claude-fresh" });
    expect(captured[0]).not.toHaveProperty("backendSessionRolloverFrom");
    expect(task.claudeBackendRolloverAttempts).toBe(0);
    expect(task.claudeBackendRolloverCycleFrom).toBeUndefined();
    expect(task.status).toBe("completed");
  });

  it("성공한 rollover 뒤 다음 독립 context exhaustion에 1회 recovery를 다시 허용한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.codexThreadId = "claude-old";
    task.interventionQueue.push({ text: "first exhaustion", user: "u" });
    const captured: EngineExecuteParams[] = [];
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        captured.push(params);
        if (captured.length === 1 || captured.length === 3) {
          yield {
            type: "error",
            message: "Prompt is too long",
            fatal: false,
            error_code: "claude_prompt_too_long",
          } as SSEEventPayload;
          return;
        }
        const freshSessionId = captured.length === 2 ? "claude-fresh-1" : "claude-fresh-2";
        yield { type: "session", session_id: freshSessionId } as SSEEventPayload;
        if (captured.length === 2) {
          task.interventionQueue.push({ text: "second independent exhaustion", user: "u" });
        }
        yield { type: "complete", result: "recovered" } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const fakeBuilder = {
      buildFollowupContext: vi.fn(async () => ({ contextItems: [] })),
      buildBackendRolloverContext: vi.fn(async () => ({ contextItems: [] })),
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(captured).toHaveLength(4);
    expect(captured[1]).toMatchObject({ backendSessionRolloverFrom: "claude-old" });
    expect(captured[2]).toMatchObject({ resumeSessionId: "claude-fresh-1" });
    expect(captured[3]).toMatchObject({ backendSessionRolloverFrom: "claude-fresh-1" });
    expect(task.codexThreadId).toBe("claude-fresh-2");
    expect(task.claudeBackendRolloverAttempts).toBe(0);
    expect(task.claudeBackendRolloverCycleFrom).toBeUndefined();
    expect(task.status).toBe("completed");
    expect(mocks.enqueueMetadataEffect).toHaveBeenCalledTimes(4);
  });

  it("tool 실행이 관찰된 턴은 prompt_too_long이어도 입력을 replay하지 않는다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.codexThreadId = "claude-over-limit";
    task.interventionQueue.push({ text: "unsafe replay", user: "u" });
    const execute = vi.fn();
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        execute();
        yield {
          type: "tool_start",
          tool_name: "Bash",
          tool_input: { command: "side effect" },
          tool_use_id: "tool-1",
        } as SSEEventPayload;
        yield {
          type: "error",
          message: "Prompt is too long",
          fatal: false,
          error_code: "claude_prompt_too_long",
        } as SSEEventPayload;
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
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueMetadataEffect).not.toHaveBeenCalled();
    expect(task.status).toBe("error");
  });

  it("모델 window의 85%를 넘긴 context telemetry는 다음 입력 전에 compact를 한 번 실행한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.codexThreadId = "claude-session-1";
    const compact = vi.fn().mockResolvedValue(undefined);
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        yield {
          type: "context_usage",
          used_tokens: 850_000,
          max_tokens: 1_000_000,
          percent: 85,
        } as SSEEventPayload;
        yield { type: "complete", result: "done" } as SSEEventPayload;
      },
      compact,
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith("claude-session-1");
    expect(mocks.persistEvent).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({ type: "compact", trigger: "auto_preemptive" }),
      undefined,
      1,
    );
  });

  it("Claude compact 이벤트는 P3 wire 그대로 persist/broadcast된다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(): AsyncIterable<SSEEventPayload> {
        yield {
          type: "compact",
          trigger: "auto",
          message: "context compacted",
          timestamp: 1,
        } as SSEEventPayload;
        yield { type: "complete", result: "done", timestamp: 2 } as SSEEventPayload;
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
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    const compactPersist = mocks.persistEvent.mock.calls.find(
      (call) => (call[1] as { type: string }).type === "compact",
    );
    expect(compactPersist?.[1]).toMatchObject({
      type: "compact",
      trigger: "auto",
      message: "context compacted",
    });
    const compactBroadcast = mocks.emitEventEnvelope.mock.calls.find(
      (call) => (call[1] as { type: string }).type === "compact",
    );
    expect(compactBroadcast).toBeUndefined();
  });

  it("compact 후 첫 queued intervention만 full context/systemPrompt를 재주입한다", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    task.profileId = claudeAgent.id;
    const capturedSystemPrompts: Array<string | undefined> = [];
    const capturedPrompts: string[] = [];
    let turnCount = 0;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedSystemPrompts.push(params.systemPrompt);
        capturedPrompts.push(params.prompt);
        turnCount += 1;
        if (turnCount === 1) {
          yield {
            type: "compact",
            trigger: "auto",
            message: "context compacted",
            timestamp: 1,
          } as SSEEventPayload;
          task.interventionQueue.push({ text: "after compact", user: "u" });
          yield { type: "complete", result: "first", timestamp: 2 } as SSEEventPayload;
          return;
        }
        yield { type: "complete", result: "second", timestamp: 3 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const fakeBuilder = {
      build: vi.fn(async () => ({
        effectiveSystemPrompt: "initial system",
        combinedContextItems: [],
        assembledPrompt: "hi",
      })),
      buildSystemPrompt: vi.fn(async () => "unused"),
      buildFollowupContext: vi.fn(async () => ({
        effectiveSystemPrompt: "full system after compact",
        contextItems: [
          { key: "soulstream_session", label: "Soulstream", content: "full" },
          { key: "running_sessions", label: "Running Sessions", content: [] },
        ],
      })),
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turnCount).toBe(2);
    expect(fakeBuilder.buildFollowupContext).toHaveBeenCalledWith(
      task,
      claudeAgent,
      expect.objectContaining({ includeFullContext: true }),
    );
    expect(capturedSystemPrompts).toEqual([
      "initial system",
      "full system after compact",
    ]);
    expect(capturedPrompts[1]).toContain("after compact");
    expect(capturedPrompts[1]).toContain("<soulstream_session>");
    expect(task.needsFullContextReinjection).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TaskExecutor engine event publishing — durable ingress / transient wire split", () => {
  it("persistent 이벤트는 ingress에만, text lifecycle은 ID 없는 wire에만 둔다", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-x" } as SSEEventPayload,
      { type: "text_start", timestamp: 1 } as SSEEventPayload,
      { type: "text_delta", text: "hi", timestamp: 1 } as SSEEventPayload,
      { type: "prompt_suggestion", text: "follow-up", timestamp: 1.5 } as SSEEventPayload,
      { type: "credential_alert", status: "allowed_warning", utilization: 0.91, timestamp: 1.6 } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 2 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    const persistedTypes = mocks.persistEvent.mock.calls.map(
      (call) => (call[1] as { type: string }).type,
    );
    expect(persistedTypes).toEqual([
      "user_message",
      "session",
      "prompt_suggestion",
      "credential_alert",
      "complete",
      "session_ended",
    ]);
    expect(mocks.emitEventEnvelope.mock.calls.map(
      (call) => (call[1] as { type: string }).type,
    )).toEqual(["text_start", "text_delta"]);
    expect(mocks.emitEventEnvelope.mock.calls.every(
      (call) => (call[1] as Record<string, unknown>)._event_id === undefined,
    )).toBe(true);
  });

  it("persistent ingress 실패는 해당 turn을 중단하고 terminal event로 닫는다", async () => {
    const mocks = makeMocks();
    // user_message persist는 성공, 첫 turn event persist는 실패하도록 시뮬레이션
    let callCount = 0;
    mocks.persistEvent.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error("events db down");
      return callCount;
    });
    const events: SSEEventPayload[] = [
      { type: "assistant_message", content: "hi", timestamp: 1 } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 2 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("error");
    expect(mocks.persistEvent.mock.calls.map(
      (call) => (call[1] as { type: string }).type,
    )).toEqual(["user_message", "assistant_message", "session_ended"]);
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
  });
});

// B-5: 초기 system_message + user_message 영속화 (Python `_persist_initial_messages` 정합)
// 본 describe는 contextBuilder 미주입(legacy) 흐름. system_message·user_message.context는
// 별 describe(`TaskExecutor initial message publishing with contextBuilder`)에서 검증.
describe("TaskExecutor initial message publishing — contextBuilder 미주입 (legacy)", () => {
  it("첫 turn 진입 전 user_message가 durable ingress + side effect를 수행", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-x" } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    task.callerInfo = { source: "slack", display_name: "Alice" };
    executor.startExecution(task, agent);
    await task.executionPromise;

    const firstCall = mocks.persistEvent.mock.calls[0];
    expect(firstCall[0]).toBe("sess-1");  // sessionId
    expect(firstCall[1]).toMatchObject({
      type: "user_message",
      text: "hi",  // task.prompt
      user: "Alice",  // caller_info.display_name 우선
    });
    expect((firstCall[1] as Record<string, unknown>).caller_info).toEqual({
      source: "slack",
      display_name: "Alice",
    });

    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("caller_info 미설정 → user 필드는 'unknown', caller_info 키 미박음", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();  // callerInfo 미설정
    executor.startExecution(task, agent);
    await task.executionPromise;

    const first = mocks.persistEvent.mock.calls[0][1] as Record<string, unknown>;
    expect(first.user).toBe("unknown");
    expect(first.caller_info).toBeUndefined();
  });

  it("context builder가 없어도 내부 page source marker는 user_message에 노출하지 않는다", async () => {
    const mocks = makeMocks();
    const executor = new TaskExecutor(
      () => makeFakeEngine([{ type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload]),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    task.contextItems = [
      { key: "page_context_sources", label: "internal", content: { pages: [{ page_id: "page-1" }] } },
      { key: "visible", label: "Visible", content: "keep" },
    ];
    executor.startExecution(task, agent);
    await task.executionPromise;

    const first = mocks.persistEvent.mock.calls[0][1] as Record<string, unknown>;
    expect(first.context).toEqual([{ key: "visible", label: "Visible", content: "keep" }]);
  });

  it("user_message ingress 실패 시 engine을 시작하지 않고 terminal error로 닫는다", async () => {
    const mocks = makeMocks();
    mocks.persistEvent.mockImplementationOnce(async () => {
      throw new Error("user_message db down");
    });
    mocks.persistEvent.mockImplementation(async () => 42);
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;
    expect(task.status).toBe("error");
  });

  it("auto-resume task (queue에 메시지 push된 상태로 startExecution) → 접수 시 기록된 user_message를 중복 발행하지 않는다", async () => {
    // 완료 세션의 재개 메시지는 AutoResumeTransition이 접수 시점에 이미 기록한다.
    // executor는 queue를 엔진에 전달하되 timeline 이벤트를 다시 만들지 않는다.
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    task.prompt = "second turn";
    task.interventionQueue.push({ text: "second turn", user: "u" });
    executor.startExecution(task, agent);
    await task.executionPromise;

    const userMessages = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(userMessages).toHaveLength(0);
  });

  it("auto-resume task: 첫 turn prompt = queue dequeue.text (task.prompt 재실행 안 함)", async () => {
    // P0 fix 핵심 회귀: queue 있는 task는 첫 turn engine.execute에 *queue 메시지*를 prompt로 전달.
    // task.prompt는 prior turn에서 이미 codex thread에 처리된 원래 발화 — 재실행하면 중복 응답.
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    let capturedPrompt: string | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedPrompt = params.prompt;
        for (const e of events) yield e;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();  // task.prompt = "hi" (원래 prompt)
    task.interventionQueue.push({ text: "new message", user: "u" });
    executor.startExecution(task, agent);
    await task.executionPromise;
    expect(capturedPrompt).toBe("new message");  // task.prompt="hi"가 아니라 queue dequeue
  });

  it("auto-resume attachmentPaths → 이미지 attachment는 EngineExecuteParams.imageAttachmentPaths로 전달", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    let capturedPrompt = "";
    let capturedImageAttachmentPaths: string[] | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedPrompt = params.prompt;
        capturedImageAttachmentPaths = params.imageAttachmentPaths;
        for (const e of events) yield e;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    task.interventionQueue.push({
      text: "이 파일 보여?",
      user: "u",
      attachmentPaths: ["/tmp/incoming/sess/a.png"],
    });
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(capturedPrompt).toBe(
      "이 파일 보여?\n\n[첨부 파일 로컬 경로: /tmp/incoming/sess/a.png]",
    );
    expect(capturedImageAttachmentPaths).toEqual(["/tmp/incoming/sess/a.png"]);
  });

  it("auto-resume attachmentPaths → 본문 note에 남고 이미지는 imageAttachmentPaths로도 분리된다", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    let capturedPrompt = "";
    let capturedImageAttachmentPaths: string[] | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedPrompt = params.prompt;
        capturedImageAttachmentPaths = params.imageAttachmentPaths;
        for (const e of events) yield e;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    task.interventionQueue.push({
      text: "첨부 확인",
      user: "u",
      attachmentPaths: ["/tmp/incoming/sess/a.png", "/tmp/incoming/sess/readme.txt"],
    });
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(capturedImageAttachmentPaths).toEqual(["/tmp/incoming/sess/a.png"]);
    expect(capturedPrompt).toContain(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/a.png]",
    );
    expect(capturedPrompt).toContain(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/readme.txt]",
    );
    expect(capturedPrompt).toContain("/tmp/incoming/sess/readme.txt");
    expect(capturedPrompt.endsWith(
      "[첨부 파일 로컬 경로: /tmp/incoming/sess/readme.txt]",
    )).toBe(true);
  });
});

// B-6 정정: contextBuilder 주입 흐름에서 system_message 영속화 + user_message.context 박힘
// (Python `_persist_initial_messages` 복수형 정합). 분석 캐시
// `20260518-0945-codex-context-mcp-cancel.md` Part A-3a wire emit 누락 root cause 해소.
describe("TaskExecutor initial message publishing — contextBuilder 주입 (Python 복수형 정합)", () => {
  // contextBuilder mock 헬퍼 — build() 반환을 직접 제어
  function makeFakeContextBuilder(
    ctx: {
      effectiveSystemPrompt?: string;
      combinedContextItems: Array<{ key: string; label: string; content: unknown }>;
      assembledPrompt: string;
    },
  ): {
    build: ReturnType<typeof vi.fn>;
    buildFollowupContext: ReturnType<typeof vi.fn>;
  } {
    return {
      build: vi.fn(async () => ctx),
      buildFollowupContext: vi.fn(async () => ({
        contextItems: [
          {
            key: "running_sessions",
            label: "Running Sessions",
            content: { status: "ok", sessions: [] },
          },
        ],
      })),
    };
  }

  it("effectiveSystemPrompt 있음 → system_message 이벤트 영속화 + broadcast (Python L133-146)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = makeFakeContextBuilder({
      effectiveSystemPrompt: "you are codex",
      combinedContextItems: [],
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // persistEvent 첫 호출은 system_message (Python 순서 — system_message 먼저, user_message 다음).
    // payload는 *strict equal* {type, text} 2키만 — Python L136-139·soul-ui SystemMessageEvent 정합.
    // 추가 키(timestamp 등) 잔존 회귀를 차단한다.
    const calls = mocks.persistEvent.mock.calls;
    const sysCall = calls.find((c) => (c[1] as { type: string }).type === "system_message");
    expect(sysCall).toBeDefined();
    expect(sysCall![1]).toEqual({
      type: "system_message",
      text: "you are codex",
    });
    const sysEnvelope = mocks.emitEventEnvelope.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "system_message",
    );
    expect(sysEnvelope).toBeUndefined();
  });

  it("effectiveSystemPrompt 없음 → system_message 영속화 skip (Python L134 가드 정합)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = makeFakeContextBuilder({
      // effectiveSystemPrompt undefined
      combinedContextItems: [],
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    const sysCalls = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "system_message",
    );
    expect(sysCalls.length).toBe(0);
  });

  it("combinedContextItems 있음 → user_message 페이로드에 context 키 박힘 (Python L155)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const items = [
      { key: "soulstream_session", label: "Soulstream 세션 정보", content: { foo: 1 } },
      { key: "atom_context", label: "atom 트리", content: "# tree\n..." },
    ];
    const fakeBuilder = makeFakeContextBuilder({
      combinedContextItems: items,
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    const userCall = mocks.persistEvent.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(userCall).toBeDefined();
    expect((userCall![1] as Record<string, unknown>).context).toEqual(items);
  });

  it("Claude 첫 turn은 systemPrompt를 SDK 옵션으로 분리 + context items만 prompt에 prepend (Phase B parity)", async () => {
    // Phase B 정정: claude backend는 SDK가 turn-level system_prompt를 직접 받음 →
    // effectiveSystemPrompt는 SDK 옵션으로 분리하고 prompt 본문에는 context items만 prepend.
    // codex backend는 별 케이스(`codex backend: effectiveSystemPrompt를 turnPrompt에 prepend ...`)에서 검증.
    const mocks = makeMocks();
    let capturedPrompt: string | undefined;
    let capturedSystemPrompt: string | undefined;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedPrompt = params.prompt;
        capturedSystemPrompt = params.systemPrompt;
        yield { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const fakeBuilder = makeFakeContextBuilder({
      effectiveSystemPrompt: "folder prompt\n\nagent prompt",
      combinedContextItems: [
        { key: "soulstream_session", label: "Soulstream 세션 정보", content: { session_id: "sess-1" } },
        { key: "atom_context", label: "atom 트리", content: "# atom\n- item" },
      ],
      assembledPrompt: "사용자 요청",
    });
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    task.profileId = claudeAgent.id;
    task.prompt = "사용자 요청";
    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    // systemPrompt는 SDK 옵션으로 분리.
    expect(capturedSystemPrompt).toBe("folder prompt\n\nagent prompt");
    // prompt 본문에는 system prepend가 *없고*, context items만 prepend.
    expect(capturedPrompt).not.toContain("folder prompt\n\nagent prompt");
    expect(capturedPrompt).toContain("<context>");
    expect(capturedPrompt).toContain("<soulstream_session>");
    expect(capturedPrompt).toContain('"session_id": "sess-1"');
    expect(capturedPrompt).toContain("<atom_context>\n# atom\n- item\n</atom_context>");
    expect(capturedPrompt?.endsWith("사용자 요청")).toBe(true);
  });

  it("combinedContextItems 빈 배열 → user_message에 context 키 미박힘", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = makeFakeContextBuilder({
      combinedContextItems: [],
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    const userCall = mocks.persistEvent.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect((userCall![1] as Record<string, unknown>).context).toBeUndefined();
  });

  it("system_message + user_message 순서 — system_message가 먼저 (Python 정합)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = makeFakeContextBuilder({
      effectiveSystemPrompt: "sys",
      combinedContextItems: [{ key: "k", label: "L", content: "c" }],
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    const types = mocks.persistEvent.mock.calls.map((c) => (c[1] as { type: string }).type);
    const sysIdx = types.indexOf("system_message");
    const userIdx = types.indexOf("user_message");
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(sysIdx);
  });

  it("contextBuilder.build throw → ctx 격리 후 task.prompt 그대로 첫 turn 실행", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = {
      build: vi.fn(async () => {
        throw new Error("atom HTTP timeout");
      }),
    };
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // ctx 격리 → system_message 영속화 0회, user_message.context 키 미박힘 (legacy 동작)
    const sysCalls = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "system_message",
    );
    expect(sysCalls.length).toBe(0);
    const userCall = mocks.persistEvent.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect((userCall![1] as Record<string, unknown>).context).toBeUndefined();
    expect(task.status).toBe("completed");  // 본 task 진행에 영향 0
  });

  it("auto-resume (queue 비어있지 않음) → contextBuilder.build 없이 follow-up context만 붙인다", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = makeFakeContextBuilder({
      effectiveSystemPrompt: "sys",
      combinedContextItems: [{ key: "k", label: "L", content: "c" }],
      assembledPrompt: "queued",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    task.prompt = "queued";
    task.interventionQueue.push({ text: "queued", user: "u" });
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(fakeBuilder.build).not.toHaveBeenCalled();
    expect(fakeBuilder.buildFollowupContext).toHaveBeenCalledWith(
      task,
      agent,
      expect.objectContaining({ includeFullContext: false }),
    );
    const sysCalls = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "system_message",
    );
    expect(sysCalls.length).toBe(0);
    const userCall = mocks.persistEvent.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(userCall).toBeUndefined();
  });
});

// Phase B parity — system_prompt SDK 옵션 분기 + agents.yaml 도구 권한 옵션 forward
describe("TaskExecutor backend-specific first-turn composition (Phase B parity)", () => {
  function makeFakeContextBuilder(
    ctx: {
      effectiveSystemPrompt?: string;
      combinedContextItems: Array<{ key: string; label: string; content: unknown }>;
      assembledPrompt: string;
    },
  ): { build: ReturnType<typeof vi.fn> } {
    return { build: vi.fn(async () => ctx) };
  }

  it("claude backend: effectiveSystemPrompt를 SDK systemPrompt 옵션으로 분리하고 turnPrompt에 prepend 안 함", async () => {
    const mocks = makeMocks();
    let capturedSystemPrompt: string | undefined;
    let capturedPrompt: string | undefined;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedSystemPrompt = params.systemPrompt;
        capturedPrompt = params.prompt;
        yield { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const fakeBuilder = makeFakeContextBuilder({
      effectiveSystemPrompt: "you are roselin",
      combinedContextItems: [],
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    task.profileId = claudeAgent.id;
    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(capturedSystemPrompt).toBe("you are roselin");
    // turnPrompt에 system prepend가 없음 — context items도 비었으므로 task.prompt만.
    expect(capturedPrompt).toBe("hi");
  });

  it("codex backend: effectiveSystemPrompt를 turnPrompt에 prepend (SDK 미지원이라 기존 동작 유지)", async () => {
    const mocks = makeMocks();
    let capturedSystemPrompt: string | undefined;
    let capturedPrompt: string | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedSystemPrompt = params.systemPrompt;
        capturedPrompt = params.prompt;
        yield { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const fakeBuilder = makeFakeContextBuilder({
      effectiveSystemPrompt: "you are codex",
      combinedContextItems: [],
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);  // codex agent
    await task.executionPromise;

    // codex SDK는 turn-level systemPrompt 미지원 — 호출자가 prompt에 prepend.
    expect(capturedSystemPrompt).toBeUndefined();
    expect(capturedPrompt).toContain("you are codex");
    expect(capturedPrompt).toContain("hi");
  });

  it("claude backend: agents.yaml allowedTools/disallowedTools/maxTurns를 engine.execute params로 forward", async () => {
    const mocks = makeMocks();
    let capturedParams: Record<string, unknown> = {};
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedParams = { ...params };
        yield { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const claudeAgentWithOpts: AgentProfile = {
      ...claudeAgent,
      allowed_tools: ["Read", "Bash"],
      disallowed_tools: ["WebFetch"],
      max_turns: 25,
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    task.profileId = claudeAgentWithOpts.id;
    executor.startExecution(task, claudeAgentWithOpts);
    await task.executionPromise;

    expect(capturedParams.allowedTools).toEqual(["Read", "Bash"]);
    expect(capturedParams.disallowedTools).toEqual(["WebFetch"]);
    expect(capturedParams.maxTurns).toBe(25);
  });

  it("claude backend: task-level 도구/MCP 옵션이 agents.yaml보다 우선한다", async () => {
    const mocks = makeMocks();
    let capturedParams: Record<string, unknown> = {};
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedParams = { ...params };
        yield { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const claudeAgentWithOpts: AgentProfile = {
      ...claudeAgent,
      allowed_tools: ["Read"],
      disallowed_tools: ["WebFetch"],
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    task.profileId = claudeAgentWithOpts.id;
    task.allowedTools = ["Bash"];
    task.disallowedTools = ["Edit"];
    task.useMcp = false;
    executor.startExecution(task, claudeAgentWithOpts);
    await task.executionPromise;

    expect(capturedParams.allowedTools).toEqual(["Bash"]);
    expect(capturedParams.disallowedTools).toEqual(["Edit"]);
    expect(capturedParams.useMcp).toBe(false);
  });
});
