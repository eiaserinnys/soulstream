import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
  SupportsToolApproval,
} from "../../src/engine/protocol.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../../src/engine/claude_options.js";
import { TaskExecutor, isTerminalStatus } from "../../src/task/task_executor.js";
import { TaskTurnInputBuilder } from "../../src/task/task_turn_input_builder.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

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

  const updateSession = vi.fn().mockResolvedValue(undefined);
  const setClaudeSessionId = vi.fn().mockResolvedValue(undefined);
  const db = { updateSession, setClaudeSessionId } as unknown as SessionDB;

  const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
  const emitSessionUpdated = vi.fn().mockResolvedValue(undefined);
  const broadcaster = { emitEventEnvelope, emitSessionUpdated } as unknown as SessionBroadcaster;

  return {
    persistence,
    db,
    broadcaster,
    persistEvent,
    handleSideEffects,
    updateSession,
    setClaudeSessionId,
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
  it("정상 흐름: durable 이벤트만 persist + 모든 이벤트 broadcast/side effect + 완료 후 session_updated", async () => {
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

    // B-5: user_message + session + assistant_message만 durable 저장.
    // text_delta/text_end는 live transport 전용이라 persist하지 않는다.
    expect(mocks.persistEvent).toHaveBeenCalledTimes(3);
    expect(mocks.emitEventEnvelope).toHaveBeenCalledTimes(6);
    expect(mocks.handleSideEffects).toHaveBeenCalledTimes(5);

    // 첫 persistEvent는 user_message 영속화
    expect(mocks.persistEvent.mock.calls[0][1]).toMatchObject({
      type: "user_message",
      text: "hi",
    });

    expect(task.status).toBe("completed");
    expect(task.lastEventId).toBe(3);
    expect(task.codexThreadId).toBe("thr-1");
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(task.engine).toBeUndefined();

    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      status: "completed",
      last_event_id: 3,
      termination_reason: "completed_ok",
    }));
    expect(mocks.emitSessionUpdated).toHaveBeenCalledWith(task);
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
    ]);
    expect(mocks.emitEventEnvelope).toHaveBeenCalledTimes(7);
    expect(mocks.handleSideEffects).toHaveBeenCalledTimes(6);
    const broadcastEventIds = mocks.emitEventEnvelope.mock.calls.map(
      (c) => (c[1] as Record<string, unknown>)._event_id,
    );
    expect(broadcastEventIds).toEqual([
      1,
      undefined,
      undefined,
      undefined,
      2,
      undefined,
      undefined,
    ]);
    expect(task.lastEventId).toBe(2);
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      status: "completed",
      last_event_id: 2,
      termination_reason: "completed_ok",
    }));
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
    expect(mocks.setClaudeSessionId).toHaveBeenCalledWith("sess-1", "claude-sess-1");
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      status: "completed",
      last_event_id: 4,
      termination_reason: "completed_ok",
    }));
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

    await waitFor(() => mocks.emitEventEnvelope.mock.calls.some(
      (c) => (c[1] as { type: string }).type === "tool_approval_requested",
    ));
    const approvalResult = await (task.engine as EnginePort & SupportsToolApproval)
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
      async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
        captured = params;
        await params.onRunStateSnapshot?.({
          backendId: "openai-agents",
          serialized: "state-v2",
          pendingApprovalId: "danger-call-1",
          previousResponseId: "resp-2",
          conversationId: "conv-2",
          schemaVersion: "1.11",
        });
        await params.onSessionItemsSnapshot?.({
          backendId: "openai-agents",
          items: [{ role: "user", content: "hi" }],
        });
        yield {
          type: "complete",
          result: "resumed",
          attachments: [],
          timestamp: 4,
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
    expect(mocks.updateSession).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        metadata: expect.arrayContaining([
          expect.objectContaining({
            type: "agents_run_state",
            value: expect.objectContaining({
              serialized: "state-v2",
              pendingApprovalId: "danger-call-1",
              previousResponseId: "resp-2",
              conversationId: "conv-2",
            }),
          }),
          expect.objectContaining({
            type: "agents_session_items",
            value: expect.objectContaining({
              items: [{ role: "user", content: "hi" }],
            }),
          }),
        ]),
      }),
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
    expect(mocks.emitSessionUpdated).toHaveBeenCalled();
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      status: "error",
      last_event_id: 2,  // B-5: user_message(1) + session(2)
      termination_reason: "unknown",
    }));
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
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      status: "error",
      last_event_id: 2,
      termination_reason: "error_aborted",
    }));
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
    expect(task.engine).toBeUndefined();
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(task.claudeRuntime).toMatchObject({
      sessionState: "idle",
      tasks: {
        "task-bg-timeout": {
          status: "failed",
        },
      },
    });
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      status: "error",
      last_event_id: 7,
      termination_reason: "error_aborted",
    }));
    expect(mocks.emitSessionUpdated).toHaveBeenCalledWith(task);
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
    expect(task.engine).toBeUndefined();
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
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      status: "completed",
      last_event_id: 2,
      termination_reason: "completed_ok",
    }));
    expect(mocks.emitSessionUpdated).toHaveBeenCalledWith(task);
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
    expect(task.engine).toBeUndefined();
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
    const errorBroadcast = mocks.emitEventEnvelope.mock.calls.find(
      (call) => (call[1] as { type: string }).type === "error",
    );
    expect(errorBroadcast?.[1]).toMatchObject({
      type: "error",
      fatal: true,
      recoverable: true,
      recovery_hint: expect.stringContaining("Send another message"),
      error_code: "claude_runtime_pending_after_turn",
      _event_id: expect.any(Number),
    });
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      status: "error",
      last_event_id: expect.any(Number),
      termination_reason: "error_aborted",
    }));
    expect(mocks.emitSessionUpdated).toHaveBeenCalledWith(task);
  });

  it("persistEvent 실패는 격리 (계속 진행)", async () => {
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

    // 첫 persistEvent throw(user_message 영속화)에도 status=completed (격리)
    // user_message(1, throw) + assistant_message(2) + complete(3) = 3건 호출
    expect(task.status).toBe("completed");
    expect(mocks.persistEvent).toHaveBeenCalledTimes(3);
    // emitEventEnvelope는 user_message + 2건 = 3건 (persistEvent throw에도 broadcast는 호출됨)
    expect(mocks.emitEventEnvelope).toHaveBeenCalledTimes(4);
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

  it("F-3B T6: 첫 session 이벤트 시 db.setClaudeSessionId 호출 + 두 번째 session 이벤트는 호출 안 함", async () => {
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

    // DB: setClaudeSessionId 정확히 1회 호출 + 첫 thread id로
    expect(mocks.setClaudeSessionId).toHaveBeenCalledTimes(1);
    expect(mocks.setClaudeSessionId).toHaveBeenCalledWith(
      "sess-1",
      "thr-codex-1",
    );
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
    expect(mocks.persistEvent).toHaveBeenCalledTimes(3);
    expect(mocks.handleSideEffects).toHaveBeenCalledTimes(3);
  });

  it("F-3B T7: db.setClaudeSessionId throw → 격리 (task 진행 계속, status=completed)", async () => {
    const mocks = makeMocks();
    mocks.setClaudeSessionId.mockRejectedValueOnce(
      new Error("connection refused"),
    );

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

    // setClaudeSessionId throw에도 task 진행 계속
    expect(task.status).toBe("completed");
    expect(task.codexThreadId).toBe("thr-codex-1");  // 메모리 박기는 throw 전에 완료
    // user_message(1) + session(2) + assistant_message(3) = 3건 durable 저장
    expect(mocks.persistEvent).toHaveBeenCalledTimes(3);
    expect(mocks.emitSessionUpdated).toHaveBeenCalled();
  });

  it("같은 task에 startExecution 두 번 호출 → throw", () => {
    const mocks = makeMocks();
    const engine = makeFakeEngine([]);
    const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    expect(() => executor.startExecution(task, agent)).toThrow(/already has an engine/);
  });

  it("interrupt 경로: cancelTask가 status='interrupted' 박은 뒤 정상 drain → completed로 안 덮임 (code-reviewer P1)", async () => {
    const mocks = makeMocks();
    // engine.execute가 *정상* 종료하는 fake (interrupt가 발생해 adapter가 yield 없이 return하는 시나리오 등가)
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_delta", text: "partial", timestamp: 1 } as SSEEventPayload,
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
    // task_executor가 yield 처리 *전* 외부에서 status="interrupted" 박힘 (cancelTask 시뮬)
    // 단, executionPromise가 이미 진행 중이라 micro-task 대기 후 status 설정
    await Promise.resolve();
    task.status = "interrupted";
    await task.executionPromise;
    // 정상 종료 분기의 `if (status === "running") status = "completed"`가 발동 안 함
    expect(task.status).toBe("interrupted");
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      status: "interrupted",
      last_event_id: expect.any(Number),
      termination_reason: "unknown",
    }));
  });

  it("engineFactory throw → status=error, finalize 호출", async () => {
    const mocks = makeMocks();
    const factory = vi.fn(() => {
      throw new Error("factory boom");
    });
    const executor = new TaskExecutor(factory, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    // startExecution 자체는 engine 설정 단계에서 throw 발생 — *동기 throw*는 호출자에게 직접 전파
    expect(() => executor.startExecution(task, agent)).toThrow(/factory boom/);
    // task.engine은 설정 안 됨
    expect(task.engine).toBeUndefined();
  });

  it("outer execution failure finalizes and notifies skipped queued interventions", async () => {
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
    expect(task.interventionQueue).toEqual([]);
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      status: "error",
      last_event_id: 0,
      termination_reason: "unknown",
    }));
    const errorBroadcast = mocks.emitEventEnvelope.mock.calls.find(
      (c) =>
        (c[1] as { type: string }).type === "error" &&
        /2 queued intervention\(s\) skipped/.test((c[1] as { message: string }).message),
    );
    expect(errorBroadcast).toBeDefined();
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
    expect(mocks.emitSessionUpdated).toHaveBeenCalled();
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

  it("P1-3: turn 진행 중 intervention 도착 후 turn throw → interventionQueue 미처리 메시지 wire error 이벤트 발행 + queue 정리", async () => {
    // 사용자가 인터벤션을 보냈는데(intervention_sent broadcast 수신) 그 직후 turn이 throw하면
    // 메시지가 silent로 사라진다. 사용자에게 명시 error 이벤트로 통지하여 재전송 결정 가능하게 한다.
    // B-5 P0 fix 반영: queue가 비어있는 신규 task로 시작 → engine generator 진행 중 push →
    // generator throw → catch 분기에서 queue 비어있지 않으면 error 발행 (PR #52 의도 유지).
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
    expect(task.interventionQueue).toHaveLength(0);  // 재처리 방지로 비움
    // 사용자 통지를 위한 wire error 이벤트가 broadcast됨
    const errorBroadcast = mocks.emitEventEnvelope.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "error" && /skipped/.test((c[1] as { message: string }).message),
    );
    expect(errorBroadcast).toBeDefined();
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
    expect(compactBroadcast?.[1]).toMatchObject({
      type: "compact",
      trigger: "auto",
      message: "context compacted",
      _event_id: expect.any(Number),
    });
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

// ride-along 5자리: `_event_id` envelope 운반 (Ft1NJquP — Python `task_executor.py:248` 정합)
describe("TaskExecutor engine event publishing — _event_id ride-along (Python L248 정합)", () => {
  // 분석 캐시 `20260518-1338-codex-live-event-id-race.md`: persistEvent에서 받은 id를 event dict에
  // `_event_id`로 박은 뒤 broadcast. orch session_events.py가 SSE id로 추출하여 대시보드
  // tree-placer가 dedup·순서 보장. 누락 시 모든 live 이벤트가 eventId=0으로 같은 키 취급되어
  // text_start skip → text_delta/end 미박힘 (라이브 결함 root cause).

  it("매 event broadcast envelope에 _event_id가 박힌다 (persistEvent eventId 정합)", async () => {
    const mocks = makeMocks();  // persistEvent가 nextEventId++ 반환
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

    // user_message + 6 turn events = 7 emit
    const emitCalls = mocks.emitEventEnvelope.mock.calls;
    const eventIdsByType = new Map(
      emitCalls.map((call) => {
        const payload = call[1] as Record<string, unknown>;
        return [payload.type, payload._event_id];
      }),
    );
    expect(eventIdsByType.get("user_message")).toEqual(expect.any(Number));
    expect(eventIdsByType.get("session")).toEqual(expect.any(Number));
    expect(eventIdsByType.get("text_start")).toBeUndefined();
    expect(eventIdsByType.get("text_delta")).toBeUndefined();
    expect(eventIdsByType.get("prompt_suggestion")).toEqual(expect.any(Number));
    expect(eventIdsByType.get("credential_alert")).toEqual(expect.any(Number));
    expect(eventIdsByType.get("complete")).toEqual(expect.any(Number));
  });

  it("persistEvent throw → _event_id 미박힘 + broadcast는 계속 (격리)", async () => {
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

    // assistant_message는 persist throw — _event_id 없음. complete는 성공 — _event_id 있음.
    const assistantCall = mocks.emitEventEnvelope.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "assistant_message",
    );
    expect(assistantCall).toBeDefined();
    expect((assistantCall![1] as Record<string, unknown>)._event_id).toBeUndefined();

    const completeCall = mocks.emitEventEnvelope.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "complete",
    );
    expect(completeCall).toBeDefined();
    expect((completeCall![1] as Record<string, unknown>)._event_id).toEqual(expect.any(Number));
  });
});

// B-5: 초기 system_message + user_message 영속화 (Python `_persist_initial_messages` 정합)
// 본 describe는 contextBuilder 미주입(legacy) 흐름. system_message·user_message.context는
// 별 describe(`TaskExecutor initial message publishing with contextBuilder`)에서 검증.
describe("TaskExecutor initial message publishing — contextBuilder 미주입 (legacy)", () => {
  it("첫 turn 진입 전 user_message가 persistEvent + broadcast + handleSideEffects 모두 수행", async () => {
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

    // broadcast도 첫 envelope로
    const firstEnvelope = mocks.emitEventEnvelope.mock.calls[0];
    expect(firstEnvelope[0]).toBe("sess-1");
    expect((firstEnvelope[1] as Record<string, unknown>).type).toBe("user_message");
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

  it("persistEvent throw 시 격리 — engine.execute는 정상 진행", async () => {
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
    expect(task.status).toBe("completed");  // user_message 실패에도 task 정상 진행
  });

  it("auto-resume task (queue에 메시지 push된 상태로 startExecution) → queued user_message를 발행한다", async () => {
    // 후속 턴은 queued 사용자 개입을 처리하지만, 완료 세션에서 재시작된 첫 queued 메시지는
    // 대시보드/앱 timeline에도 user_message로 남아야 한다.
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
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0][1]).toMatchObject({
      type: "user_message",
      user: "unknown",
      text: "second turn",
    });
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
    // ride-along 5자리 — persist 직후 _event_id가 박히고 mock은 reference 저장이므로
    // strict equal에 _event_id가 포함됨. Python `task_executor.py:141` 정합.
    expect(sysCall![1]).toEqual({
      type: "system_message",
      text: "you are codex",
      _event_id: expect.any(Number),
    });
    // broadcast envelope도 strict equal — 영속과 wire 양쪽에서 형상 정합 (_event_id 포함)
    const sysEnvelope = mocks.emitEventEnvelope.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "system_message",
    );
    expect(sysEnvelope).toBeDefined();
    expect(sysEnvelope![1]).toEqual({
      type: "system_message",
      text: "you are codex",
      _event_id: expect.any(Number),
    });
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
    expect(userCall).toBeDefined();
    expect(userCall![1]).toMatchObject({
      type: "user_message",
      text: "queued",
    });
    expect((userCall![1] as Record<string, unknown>).context).toBeUndefined();
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
