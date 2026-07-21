import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EnginePort,
  SupportsToolApproval,
} from "../../src/engine/protocol.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

function makeMocks() {
  const registerSession = vi.fn().mockResolvedValue(undefined);
  const appendMetadata = vi.fn().mockResolvedValue(1);
  const deleteSession = vi.fn().mockResolvedValue(undefined);
  const updateSession = vi.fn().mockResolvedValue(undefined);
  const acknowledgeSessionReview = vi.fn().mockResolvedValue("acknowledged");
  // B-5: 폴더 배정 정본 흐름 mocks.
  const assignSessionToFolder = vi.fn().mockResolvedValue(undefined);
  const getFolderById = vi
    .fn()
    .mockResolvedValue({
      id: "claude",
      name: "사용자가 바꾼 클로드 폴더 이름",
      sort_order: 0,
      settings: {},
      parent_folder_id: null,
    });
  const getCatalog = vi
    .fn()
    .mockResolvedValue({ folders: [], sessions: {} });
  // PR #56: hydration mock (Python load_evicted_task 정합)
  const getSession = vi.fn().mockResolvedValue(null);
  const db = {
    registerSession,
    appendMetadata,
    deleteSession,
    updateSession,
    acknowledgeSessionReview,
    assignSessionToFolder,
    getFolderById,
    getCatalog,
    getSession,
  } as unknown as SessionDB;

  const emitSessionCreated = vi.fn().mockResolvedValue(undefined);
  const emitSessionDeleted = vi.fn().mockResolvedValue(undefined);
  const emitCatalogUpdated = vi.fn().mockResolvedValue(undefined);
  const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
  const emitSessionUpdated = vi.fn().mockResolvedValue(undefined);
  const broadcaster = {
    emitSessionCreated,
    emitSessionDeleted,
    emitCatalogUpdated,
    emitEventEnvelope,
    emitSessionUpdated,
  } as unknown as SessionBroadcaster;

  return {
    db,
    broadcaster,
    registerSession,
    appendMetadata,
    deleteSession,
    updateSession,
    acknowledgeSessionReview,
    assignSessionToFolder,
    getFolderById,
    getCatalog,
    getSession,
    emitSessionCreated,
    emitSessionDeleted,
    emitCatalogUpdated,
    emitEventEnvelope,
    emitSessionUpdated,
  };
}

describe("TaskManager.acknowledgeReview", () => {
  it("applies the atomic DB outcome to memory and broadcasts the acknowledged state", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "sess-review",
      prompt: "review me",
      profileId: "a",
      callerInfo: { source: "browser" },
    });
    task.status = "completed";
    task.reviewState = "needs_review";
    mocks.emitSessionUpdated.mockClear();

    await expect(tm.acknowledgeReview("sess-review")).resolves.toBe("acknowledged");

    expect(mocks.acknowledgeSessionReview).toHaveBeenCalledWith("sess-review");
    expect(task.reviewState).toBe("acknowledged");
    expect(mocks.emitSessionUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ reviewState: "acknowledged" }),
    );
  });

  it("repairs stale memory and rebroadcasts an already acknowledged durable state", async () => {
    const mocks = makeMocks();
    mocks.acknowledgeSessionReview.mockResolvedValueOnce("already_acknowledged");
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "sess-review-retry",
      prompt: "review me",
      profileId: "a",
      callerInfo: { source: "browser" },
    });
    task.status = "completed";
    task.reviewState = "needs_review";
    mocks.emitSessionUpdated.mockClear();

    await expect(tm.acknowledgeReview("sess-review-retry")).resolves.toBe(
      "already_acknowledged",
    );

    expect(task.reviewState).toBe("acknowledged");
    expect(mocks.emitSessionUpdated).toHaveBeenCalledWith(task);
  });

  it("retries the cache broadcast after the first acknowledge broadcast fails", async () => {
    const mocks = makeMocks();
    mocks.acknowledgeSessionReview
      .mockResolvedValueOnce("acknowledged")
      .mockResolvedValueOnce("already_acknowledged");
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "sess-review-broadcast-retry",
      prompt: "review me",
      profileId: "a",
      callerInfo: { source: "browser" },
    });
    task.status = "completed";
    task.reviewState = "needs_review";
    mocks.emitSessionUpdated.mockClear();
    mocks.emitSessionUpdated.mockRejectedValueOnce(new Error("ws down"));

    await expect(tm.acknowledgeReview(task.agentSessionId)).resolves.toBe("acknowledged");
    await expect(tm.acknowledgeReview(task.agentSessionId)).resolves.toBe(
      "already_acknowledged",
    );

    expect(mocks.emitSessionUpdated).toHaveBeenCalledTimes(2);
    expect(task.reviewState).toBe("acknowledged");
  });

  it("keeps durable acknowledge success when runtime hydration is unavailable", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);

    await expect(tm.acknowledgeReview("sess-review-evicted")).resolves.toBe(
      "acknowledged",
    );

    expect(mocks.getSession).toHaveBeenCalledWith("sess-review-evicted");
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
  });

  it.each(["not_found", "not_required", "not_pending"] as const)(
    "keeps %s as an error outcome without runtime repair",
    async (outcome) => {
      const mocks = makeMocks();
      mocks.acknowledgeSessionReview.mockResolvedValueOnce(outcome);
      const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);

      await expect(tm.acknowledgeReview("sess-review-error")).resolves.toBe(outcome);

      expect(mocks.getSession).not.toHaveBeenCalled();
      expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
    },
  );
});

describe("TaskManager.createTask", () => {
  it("Task 생성 + DB registerSession + caller_info metadata + broadcast session_created", async () => {
    const { db, broadcaster, registerSession, appendMetadata, emitSessionCreated } = makeMocks();
    const tm = new TaskManager("eias-shopping-ts", db, broadcaster, silentLogger);

    const task = await tm.createTask({
      agentSessionId: "sess-1",
      prompt: "hi",
      profileId: "codex-default",
      callerInfo: { source: "slack" },
    });

    expect(task.agentSessionId).toBe("sess-1");
    expect(task.status).toBe("running");
    expect(task.profileId).toBe("codex-default");
    expect(task.createdAt).toBeInstanceOf(Date);

    expect(registerSession).toHaveBeenCalledTimes(1);
    const regArg = registerSession.mock.calls[0][0];
    expect(regArg.sessionId).toBe("sess-1");
    expect(regArg.nodeId).toBe("eias-shopping-ts");
    expect(regArg.agentId).toBe("codex-default");
    expect(regArg.sessionType).toBe("claude");
    expect(regArg.status).toBe("running");
    expect(appendMetadata).toHaveBeenCalledWith("sess-1", {
      type: "caller_info",
      value: { source: "slack" },
    });
    expect(task.metadata).toEqual([
      { type: "caller_info", value: { source: "slack" } },
    ]);

    expect(emitSessionCreated).toHaveBeenCalledTimes(1);
    expect(emitSessionCreated.mock.calls[0][1]).toBe("claude");
  });

  it("callerInfo 부재/빈 객체면 metadata append 생략", async () => {
    const { db, broadcaster, appendMetadata } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);

    const noCaller = await tm.createTask({
      agentSessionId: "s-no",
      prompt: "x",
      profileId: "a",
    });
    const emptyCaller = await tm.createTask({
      agentSessionId: "s-empty",
      prompt: "x",
      profileId: "a",
      callerInfo: {},
    });

    expect(appendMetadata).not.toHaveBeenCalled();
    expect(noCaller.metadata).toEqual([]);
    expect(emptyCaller.metadata).toEqual([]);
  });

  it("reasoningEffort를 task에 보존한다", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);

    const task = await tm.createTask({
      agentSessionId: "s-reasoning",
      prompt: "x",
      profileId: "a",
      reasoningEffort: "high",
    });

    expect(task.reasoningEffort).toBe("high");
  });

  it("요청별 도구/MCP 옵션을 task에 보존한다", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);

    const task = await tm.createTask({
      agentSessionId: "s-tools",
      prompt: "x",
      profileId: "a",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      useMcp: false,
    });

    expect(task.allowedTools).toEqual(["Read"]);
    expect(task.disallowedTools).toEqual(["Bash"]);
    expect(task.useMcp).toBe(false);
  });

  it("중복 agentSessionId → throw, DB·broadcast 호출 안 함", async () => {
    const { db, broadcaster, registerSession, emitSessionCreated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({ agentSessionId: "dup", prompt: "x", profileId: "a" });
    expect(registerSession).toHaveBeenCalledTimes(1);

    await expect(
      tm.createTask({ agentSessionId: "dup", prompt: "y", profileId: "a" }),
    ).rejects.toThrow(/already exists/);
    expect(registerSession).toHaveBeenCalledTimes(1);  // 2번째 호출 없음
    expect(emitSessionCreated).toHaveBeenCalledTimes(1);
  });

  it("DB registerSession 실패 시 throw + in-memory 미저장", async () => {
    const { broadcaster } = makeMocks();
    const failRegister = vi.fn().mockRejectedValue(new Error("PK violation"));
    const db = {
      registerSession: failRegister,
      deleteSession: vi.fn(),
    } as unknown as SessionDB;

    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await expect(
      tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "a" }),
    ).rejects.toThrow(/PK violation/);
    expect(tm.getTask("s1")).toBeUndefined();
  });

  it("broadcast 실패해도 task는 생성 (실패 격리)", async () => {
    const { db } = makeMocks();
    const broadcaster = {
      emitSessionCreated: vi.fn().mockRejectedValue(new Error("ws closed")),
    } as unknown as SessionBroadcaster;

    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "s1",
      prompt: "x",
      profileId: "a",
    });
    expect(task).toBeDefined();
    expect(tm.getTask("s1")?.agentSessionId).toBe("s1");
  });

  it("folderId 전달 시 emit_session_created에 그대로 박힘", async () => {
    const { db, broadcaster, emitSessionCreated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s1",
      prompt: "x",
      profileId: "a",
      folderId: "folder-42",
    });
    expect(emitSessionCreated.mock.calls[0][1]).toBe("folder-42");
  });
});

describe("TaskManager.deliverToolApproval", () => {
  it("running task의 tool approval reject를 engine capability에 전달하고 resolved SSE를 남김", async () => {
    const { db, broadcaster, emitEventEnvelope } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "sess-approval",
      prompt: "dangerous tool",
      profileId: "agent-openai",
    });
    const deliverToolApproval = vi.fn().mockResolvedValue({ status: "delivered" });
    task.engine = {
      backendId: "openai-agents",
      workspaceDir: "/tmp/agents",
      async *execute(): AsyncIterable<never> {},
      async interrupt() { return true; },
      async close() {},
      deliverToolApproval,
    } as EnginePort & SupportsToolApproval;

    const result = await tm.deliverToolApproval({
      agentSessionId: "sess-approval",
      approvalId: "danger-call-1",
      decision: "rejected",
      message: "no prod write",
    });

    expect(result).toMatchObject({
      status: "delivered",
      approvalId: "danger-call-1",
      decision: "rejected",
    });
    expect(deliverToolApproval).toHaveBeenCalledWith("danger-call-1", "rejected", {
      message: "no prod write",
    });
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-approval",
      expect.objectContaining({
        type: "tool_approval_resolved",
        approval_id: "danger-call-1",
        decision: "rejected",
        approved: false,
        rejected: true,
        message: "no prod write",
      }),
    );
  });

  it("tool approval capability가 없으면 input_request respond와 별도로 not_supported를 반환", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "sess-no-approval",
      prompt: "dangerous tool",
      profileId: "codex-default",
    });
    task.engine = {
      backendId: "codex",
      workspaceDir: "/tmp/codex",
      async *execute(): AsyncIterable<never> {},
      async interrupt() { return true; },
      async close() {},
    } as EnginePort;

    await expect(tm.deliverToolApproval({
      agentSessionId: "sess-no-approval",
      approvalId: "danger-call-1",
      decision: "approved",
    })).resolves.toMatchObject({
      status: "not_supported",
      approvalId: "danger-call-1",
      decision: "approved",
      backend: "codex",
    });
  });

  it("task가 없으면 session_not_found 결과 shape를 유지", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);

    await expect(tm.deliverToolApproval({
      agentSessionId: "missing-session",
      approvalId: "danger-call-1",
      decision: "approved",
    })).resolves.toEqual({
      status: "session_not_found",
      approvalId: "danger-call-1",
      decision: "approved",
    });
  });

  it("evicted terminal task는 session_not_running과 taskStatus를 반환", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-terminal-approval",
      folder_id: null,
      display_name: null,
      node_id: "n",
      session_type: "claude",
      status: "completed",
      prompt: "done flow",
      client_id: null,
      claude_session_id: "agents-thread-1",
      last_message: null,
      metadata: [],
      was_running_at_shutdown: false,
      last_event_id: 42,
      last_read_event_id: 10,
      created_at: new Date("2026-05-21T01:00:00Z"),
      updated_at: new Date("2026-05-21T01:05:00Z"),
      agent_id: "agent-openai",
      caller_session_id: null,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);

    await expect(tm.deliverToolApproval({
      agentSessionId: "sess-terminal-approval",
      approvalId: "danger-call-1",
      decision: "approved",
    })).resolves.toEqual({
      status: "session_not_running",
      approvalId: "danger-call-1",
      decision: "approved",
      taskStatus: "completed",
    });
  });

  it("evicted approval-pending Agents task를 metadata에서 hydrate하고 approval 결정 후 resume", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-evicted-approval",
      folder_id: "f-1",
      display_name: null,
      node_id: "n",
      session_type: "claude",
      status: "running",
      prompt: "dangerous flow",
      client_id: null,
      claude_session_id: "agents-thread-1",
      last_message: null,
      metadata: [
        {
          type: "agents_run_state",
          value: {
            backend: "openai-agents",
            serialized: "state-v1",
            pendingApprovalId: "danger-call-1",
            previousResponseId: "resp-1",
            conversationId: "conv-1",
            schemaVersion: "1.11",
            updatedAt: "2026-05-21T01:00:00.000Z",
          },
        },
        {
          type: "agents_session_items",
          value: {
            backend: "openai-agents",
            items: [{ role: "user", content: "hi" }],
            updatedAt: "2026-05-21T01:00:00.000Z",
          },
        },
      ],
      was_running_at_shutdown: false,
      last_event_id: 42,
      last_read_event_id: 10,
      created_at: new Date("2026-05-21T01:00:00Z"),
      updated_at: new Date("2026-05-21T01:05:00Z"),
      agent_id: "agent-openai",
      caller_session_id: null,
      away_summary: null,
    });
    const persistEvent = vi.fn().mockResolvedValue(99);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = {
      persistEvent,
      handleSideEffects,
    } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const onResume = vi.fn();

    const result = await tm.deliverToolApproval(
      {
        agentSessionId: "sess-evicted-approval",
        approvalId: "danger-call-1",
        decision: "rejected",
        message: "no prod write",
      },
      onResume,
    );

    expect(result).toMatchObject({
      status: "delivered",
      approvalId: "danger-call-1",
      decision: "rejected",
      eventId: 99,
    });
    expect(mocks.getSession).toHaveBeenCalledWith("sess-evicted-approval");
    const resumed = onResume.mock.calls[0]?.[0] as Task | undefined;
    expect(resumed).toBeDefined();
    expect(resumed).toMatchObject({
      agentSessionId: "sess-evicted-approval",
      status: "running",
      profileId: "agent-openai",
      codexThreadId: "agents-thread-1",
      agentsRunState: "state-v1",
      agentsPendingApprovalId: "danger-call-1",
      agentsPreviousResponseId: "resp-1",
      agentsConversationId: "conv-1",
      agentsSessionItems: [{ role: "user", content: "hi" }],
      agentsQueuedToolApproval: {
        approvalId: "danger-call-1",
        decision: "rejected",
        options: { message: "no prod write" },
      },
    });
    expect(mocks.emitEventEnvelope).toHaveBeenCalledWith(
      "sess-evicted-approval",
      expect.objectContaining({
        type: "tool_approval_resolved",
        approval_id: "danger-call-1",
        decision: "rejected",
        message: "no prod write",
      }),
    );
  });

  it("evicted Agents task의 approval id가 다르면 queued resume 없이 not_supported 반환", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-wrong-approval",
      folder_id: "f-1",
      display_name: null,
      node_id: "n",
      session_type: "claude",
      status: "running",
      prompt: "dangerous flow",
      client_id: null,
      claude_session_id: "agents-thread-1",
      last_message: null,
      metadata: [
        {
          type: "agents_run_state",
          value: {
            backend: "openai-agents",
            serialized: "state-v1",
            pendingApprovalId: "danger-call-1",
            previousResponseId: "resp-1",
            conversationId: "conv-1",
            schemaVersion: "1.11",
            updatedAt: "2026-05-21T01:00:00.000Z",
          },
        },
      ],
      was_running_at_shutdown: false,
      last_event_id: 42,
      last_read_event_id: 10,
      created_at: new Date("2026-05-21T01:00:00Z"),
      updated_at: new Date("2026-05-21T01:05:00Z"),
      agent_id: "agent-openai",
      caller_session_id: null,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const onResume = vi.fn();

    await expect(tm.deliverToolApproval(
      {
        agentSessionId: "sess-wrong-approval",
        approvalId: "other-call",
        decision: "rejected",
      },
      onResume,
    )).resolves.toEqual({
      status: "not_supported",
      approvalId: "other-call",
      decision: "rejected",
    });
    expect(onResume).not.toHaveBeenCalled();
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
  });
});

describe("TaskManager.getTask / listTasks", () => {
  it("createTask 후 getTask로 조회 가능, listTasks에 포함", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({ agentSessionId: "s1", prompt: "a", profileId: "p" });
    await tm.createTask({ agentSessionId: "s2", prompt: "b", profileId: "p" });

    expect(tm.getTask("s1")?.prompt).toBe("a");
    expect(tm.getTask("s2")?.prompt).toBe("b");
    expect(tm.getTask("nonexistent")).toBeUndefined();
    expect(tm.listTasks().map((t) => t.agentSessionId).sort()).toEqual(["s1", "s2"]);
  });
});

describe("TaskManager.deliverInputResponse", () => {
  it("running Claude task + pending request → engine deliver + input_request_responded persist/broadcast", async () => {
    const mocks = makeMocks();
    const persistEvent = vi.fn().mockResolvedValue(77);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { persistEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({
      agentSessionId: "sess-ask",
      prompt: "p",
      profileId: "claude-roselin",
    });
    const deliverInputResponse = vi.fn().mockResolvedValue({ status: "delivered" });
    task.engine = {
      backendId: "claude",
      workspaceDir: "/tmp/claude",
      deliverInputResponse,
      async *execute() {},
      async interrupt() { return true; },
      async close() {},
    } as unknown as EnginePort;

    const result = await tm.deliverInputResponse({
      agentSessionId: "sess-ask",
      requestId: "ask-1",
      answers: { choice: "yes" },
    });

    expect(result).toEqual({ status: "delivered", requestId: "ask-1", eventId: 77 });
    expect(deliverInputResponse).toHaveBeenCalledWith("ask-1", { choice: "yes" });
    expect(persistEvent).toHaveBeenCalledWith("sess-ask", expect.objectContaining({
      type: "input_request_responded",
      request_id: "ask-1",
    }));
    expect(mocks.emitEventEnvelope).toHaveBeenCalledWith("sess-ask", expect.objectContaining({
      type: "input_request_responded",
      request_id: "ask-1",
      _event_id: 77,
    }));
    expect(handleSideEffects).toHaveBeenCalledWith(
      "sess-ask",
      expect.objectContaining({ type: "input_request_responded" }),
      task,
    );
  });

  it.each([
    ["expired", "expired"],
    ["already_responded", "already_responded"],
    ["request_not_pending", "request_not_pending"],
  ] as const)("engine %s result → failure status without persisted responded event", async (engineStatus, expectedStatus) => {
    const mocks = makeMocks();
    const persistEvent = vi.fn().mockResolvedValue(1);
    const persistence = {
      persistEvent,
      handleSideEffects: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "sess-ask", prompt: "p", profileId: "claude-roselin" });
    task.engine = {
      backendId: "claude",
      workspaceDir: "/tmp/claude",
      deliverInputResponse: vi.fn().mockResolvedValue({ status: engineStatus }),
      async *execute() {},
      async interrupt() { return true; },
      async close() {},
    } as unknown as EnginePort;
    persistEvent.mockClear();

    const result = await tm.deliverInputResponse({
      agentSessionId: "sess-ask",
      requestId: "ask-1",
      answers: { choice: "yes" },
    });

    expect(result.status).toBe(expectedStatus);
    expect(persistEvent).not.toHaveBeenCalled();
  });

  it("missing session → session_not_found", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);

    await expect(tm.deliverInputResponse({
      agentSessionId: "missing",
      requestId: "ask-1",
      answers: {},
    })).resolves.toMatchObject({
      status: "session_not_found",
      requestId: "ask-1",
    });
  });

  it.each(["completed", "error", "interrupted"] as const)("%s task → session_not_running", async (status) => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "sess-ask", prompt: "p", profileId: "claude-roselin" });
    task.status = status;

    await expect(tm.deliverInputResponse({
      agentSessionId: "sess-ask",
      requestId: "ask-1",
      answers: {},
    })).resolves.toMatchObject({
      status: "session_not_running",
      taskStatus: status,
    });
  });

  it("Codex task는 input response capability가 없어 not_supported", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "sess-codex", prompt: "p", profileId: "codex-default" });
    task.engine = {
      backendId: "codex",
      workspaceDir: "/tmp/codex",
      async *execute() {},
      async interrupt() { return true; },
      async close() {},
    } as unknown as EnginePort;

    await expect(tm.deliverInputResponse({
      agentSessionId: "sess-codex",
      requestId: "ask-1",
      answers: {},
    })).resolves.toMatchObject({
      status: "not_supported",
      backend: "codex",
    });
  });
});

describe("TaskManager.finalizeTask", () => {
  it("result finalize → completed 상태와 usage를 기록하고 session_updated를 발행", async () => {
    const { db, broadcaster, updateSession, emitSessionUpdated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    task.lastEventId = 13;

    const result = await tm.finalizeTask({
      agentSessionId: "s1",
      result: "done",
      llmUsage: { input_tokens: 2, output_tokens: 3 },
    });

    expect(result).toBe(task);
    expect(task.status).toBe("completed");
    expect(task.result).toBe("done");
    expect(task.error).toBeUndefined();
    expect(task.llmUsage).toEqual({ input_tokens: 2, output_tokens: 3 });
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      status: "completed",
      last_event_id: 13,
      termination_reason: "completed_ok",
    }));
    expect(emitSessionUpdated).toHaveBeenCalledWith(task);
  });

  it("error finalize → error 상태와 message를 기록하고 stale result를 지움", async () => {
    const { db, broadcaster, updateSession } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    task.result = "old";

    await tm.finalizeTask({ agentSessionId: "s1", error: "boom" });

    expect(task.status).toBe("error");
    expect(task.error).toBe("boom");
    expect(task.result).toBeUndefined();
    expect(updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      status: "error",
      last_event_id: task.lastEventId,
      termination_reason: "unknown",
    }));
  });

  it("final state side effect 실패는 finalize 결과를 막지 않음", async () => {
    const { db, broadcaster, updateSession, emitSessionUpdated } = makeMocks();
    updateSession.mockRejectedValueOnce(new Error("db down"));
    emitSessionUpdated.mockRejectedValueOnce(new Error("ws down"));
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });

    await expect(tm.finalizeTask({
      agentSessionId: "s1",
      result: "done",
    })).resolves.toBe(task);

    expect(task.status).toBe("completed");
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(emitSessionUpdated).toHaveBeenCalledTimes(1);
  });

  it("result와 error가 모두 없으면 throw, task가 없으면 undefined", async () => {
    const { db, broadcaster, updateSession, emitSessionUpdated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);

    await expect(tm.finalizeTask({ agentSessionId: "s1" })).rejects.toThrow(
      /requires either result or error/,
    );
    await expect(tm.finalizeTask({
      agentSessionId: "missing",
      result: "done",
    })).resolves.toBeUndefined();

    expect(updateSession).not.toHaveBeenCalled();
    expect(emitSessionUpdated).not.toHaveBeenCalled();
  });
});

describe("TaskManager.cancelTask", () => {
  it("진행 중 engine이 있으면 interrupt 호출 + status='interrupted' 박힘 + true 반환", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    const interrupt = vi.fn().mockResolvedValue(true);
    task.engine = { interrupt } as unknown as EnginePort;

    expect(task.status).toBe("running");
    const result = await tm.cancelTask("s1");
    expect(result).toBe(true);
    expect(task.status).toBe("interrupted");  // code-reviewer P1 정정
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("없는 sessionId → false (silent return 아님 — 반환값으로 신호)", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    expect(await tm.cancelTask("nonexistent")).toBe(false);
  });

  it("이미 completed task → false", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    task.status = "completed";
    task.engine = { interrupt: vi.fn() } as unknown as EnginePort;
    expect(await tm.cancelTask("s1")).toBe(false);
  });
});

describe("TaskManager.deleteTask", () => {
  it("메모리 제거 + DB deleteSession + broadcast session_deleted", async () => {
    const { db, broadcaster, deleteSession, emitSessionDeleted } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });

    await tm.deleteTask("s1");
    expect(tm.getTask("s1")).toBeUndefined();
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(emitSessionDeleted).toHaveBeenCalledWith("s1");
  });

  it("진행 중 task → interrupt + drain + cleanup", async () => {
    const { db, broadcaster, deleteSession, emitSessionDeleted } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    const interrupt = vi.fn().mockResolvedValue(true);
    task.engine = { interrupt } as unknown as EnginePort;
    task.executionPromise = Promise.resolve();

    await tm.deleteTask("s1");
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(emitSessionDeleted).toHaveBeenCalledWith("s1");
  });

  it("없는 sessionId → silent (no-op)", async () => {
    const { db, broadcaster, deleteSession, emitSessionDeleted } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.deleteTask("nonexistent");
    expect(deleteSession).not.toHaveBeenCalled();
    expect(emitSessionDeleted).not.toHaveBeenCalled();
  });
});

describe("TaskManager.shutdown", () => {
  it("모든 running task를 interrupted로 기록한 뒤 interrupt + drain", async () => {
    const { db, broadcaster, updateSession, emitSessionUpdated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const t1 = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    const t2 = await tm.createTask({ agentSessionId: "s2", prompt: "y", profileId: "p" });
    const int1 = vi.fn().mockResolvedValue(true);
    const int2 = vi.fn().mockResolvedValue(true);
    t1.engine = { interrupt: int1 } as unknown as EnginePort;
    t2.engine = { interrupt: int2 } as unknown as EnginePort;
    t1.executionPromise = Promise.resolve();
    t2.executionPromise = Promise.resolve();

    await tm.shutdown();
    expect(t1.status).toBe("interrupted");
    expect(t2.status).toBe("interrupted");
    expect(updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({
      status: "interrupted",
      last_event_id: t1.lastEventId,
      termination_reason: "killed",
      termination_detail: "shutdown",
    }));
    expect(updateSession).toHaveBeenCalledWith("s2", expect.objectContaining({
      status: "interrupted",
      last_event_id: t2.lastEventId,
      termination_reason: "killed",
      termination_detail: "shutdown",
    }));
    expect(emitSessionUpdated).toHaveBeenCalledWith(t1);
    expect(emitSessionUpdated).toHaveBeenCalledWith(t2);
    expect(int1).toHaveBeenCalledTimes(1);
    expect(int2).toHaveBeenCalledTimes(1);
  });

  it("shutdown 상태 기록 실패가 interrupt를 막지 않음", async () => {
    const { db, broadcaster, updateSession } = makeMocks();
    updateSession.mockRejectedValueOnce(new Error("db down"));
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    const interrupt = vi.fn().mockResolvedValue(true);
    task.engine = { interrupt } as unknown as EnginePort;
    task.executionPromise = Promise.resolve();

    await tm.shutdown();

    expect(task.status).toBe("interrupted");
    expect(interrupt).toHaveBeenCalledTimes(1);
  });
});

describe("TaskManager.addIntervention (B-4)", () => {
  it("running task delivers to a live engine when the engine supports active-turn steering", async () => {
    const { db, broadcaster, emitEventEnvelope } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "s-live",
      prompt: "p",
      profileId: "codex-default",
    });
    const steerActiveTurn = vi.fn().mockResolvedValue({ status: "delivered" });
    task.engine = {
      backendId: "codex",
      workspaceDir: "/tmp/codex",
      async *execute(): AsyncIterable<never> {},
      async interrupt() { return true; },
      async close() {},
      steerActiveTurn,
    } as unknown as EnginePort;

    const result = await tm.addIntervention(
      {
        agentSessionId: "s-live",
        text: "focus on the failing test",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      },
      vi.fn(),
    );

    expect(result).toEqual({ delivered: true });
    expect(task.interventionQueue).toHaveLength(0);
    expect(steerActiveTurn).toHaveBeenCalledWith({
      prompt: "focus on the failing test\n\n[첨부 파일 로컬 경로: /tmp/a.png]",
      imageAttachmentPaths: ["/tmp/a.png"],
    });
    expect(
      emitEventEnvelope.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === "intervention_sent",
      ),
    ).toHaveLength(1);
  });

  it("running Claude task records intervention_sent before queueing and interrupting for live steering", async () => {
    const { db, broadcaster, emitEventEnvelope } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "s-claude-steer",
      prompt: "p",
      profileId: "claude-default",
    });
    const steerActiveTurn = vi.fn().mockResolvedValue({ status: "delivered" });
    const interruptForSteer = vi.fn().mockResolvedValue(true);
    task.engine = {
      backendId: "claude",
      workspaceDir: "/tmp/claude",
      async *execute(): AsyncIterable<never> {},
      async interrupt() { return true; },
      async close() {},
      steerActiveTurn,
      interruptForSteer,
    } as unknown as EnginePort;

    const result = await tm.addIntervention(
      {
        agentSessionId: "s-claude-steer",
        text: "stop and change direction",
        user: "alice",
      },
      vi.fn(),
    );

    expect(result).toEqual({ steered: true, queuePosition: 1 });
    expect(interruptForSteer).toHaveBeenCalledTimes(1);
    expect(steerActiveTurn).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([
      { text: "stop and change direction", user: "alice" },
    ]);
    expect(
      emitEventEnvelope.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === "intervention_sent",
      ),
    ).toHaveLength(1);
  });

  it("running task records intervention_sent when it accepts the message into the queue", async () => {
    const { db, broadcaster, emitEventEnvelope } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    expect(task.status).toBe("running");
    expect(task.interventionQueue).toEqual([]);

    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "hello", user: "alice" },
      onResume,
    );

    expect(result).toEqual({ queued: true, queuePosition: 1 });
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.interventionQueue[0]).toMatchObject({ text: "hello", user: "alice" });
    expect(
      emitEventEnvelope.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === "intervention_sent",
      ),
    ).toHaveLength(1);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("연속 큐잉 시 queuePosition이 1, 2로 증가", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    const onResume = vi.fn();
    const r1 = await tm.addIntervention({ agentSessionId: "s1", text: "a", user: "u" }, onResume);
    const r2 = await tm.addIntervention({ agentSessionId: "s1", text: "b", user: "u" }, onResume);
    expect(r1).toEqual({ queued: true, queuePosition: 1 });
    expect(r2).toEqual({ queued: true, queuePosition: 2 });
  });

  it("completed task → user_message wire (UI 흰색) + status=running + session_updated + onResume + autoResumed", async () => {
    // 결함 A 정정 (PR #55): completed/error/interrupted → intervention_sent가 아닌
    // user_message로 wire 박힘 (Python `create_task(prompt=text)` 모델 정합).
    // 결함 B 정정: session_updated wire를 *상태 전환 직후* broadcast하여 soul-app TypingIndicator
    // (session.status === "running")가 즉시 표시.
    const broadcasterMocks = makeMocks();
    const tm = new TaskManager("n", broadcasterMocks.db, broadcasterMocks.broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "completed";
    task.completedAt = new Date();
    task.codexThreadId = "thr-1";

    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "resume", user: "u", callerInfo: { source: "agent" } },
      onResume,
    );

    expect(result).toEqual({ autoResumed: true });
    expect(task.status).toBe("running");
    expect(task.completedAt).toBeUndefined();
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.interventionQueue[0]).toMatchObject({ text: "resume", user: "u" });
    expect(task.codexThreadId).toBe("thr-1");
    expect(onResume).toHaveBeenCalledWith(task);
    // intervention_sent는 *발행 안 함* (auto-resume은 user_message 경로)
    expect(
      broadcasterMocks.emitEventEnvelope.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === "intervention_sent",
      ),
    ).toHaveLength(0);
    // session_updated가 status=running 박힌 task로 broadcast
    expect(broadcasterMocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
    expect(broadcasterMocks.emitSessionUpdated.mock.calls[0][0]).toBe(task);
    expect(broadcasterMocks.updateSession).toHaveBeenCalledWith("s1", {
      status: "running",
      last_event_id: task.lastEventId,
      termination_reason: null,
      termination_detail: null,
      review_state: "not_required",
    });
  });

  it("T-1 (Phase A context 정본): completed task auto-resume은 user_message를 executor initial path로 넘김", async () => {
    // contextBuilder는 addIntervention 단계가 아니라 executor initial-message path에서 호출된다.
    const broadcasterMocks = makeMocks();
    const soulstreamItem = {
      key: "soulstream_session",
      label: "Soulstream 세션 정보",
      content: { agent_session_id: "s1", folder: "(unassigned)" },
    };
    const buildResumeContextItems = vi.fn().mockResolvedValue([soulstreamItem]);
    const contextBuilder = { buildResumeContextItems } as unknown as import(
      "../../src/context/context_builder.js"
    ).ExecutionContextBuilder;
    const agentRegistry = {
      get: vi.fn().mockReturnValue({
        id: "codex-default",
        name: "Codex Default",
        backend: "codex",
        workspace_dir: "/tmp/codex",
      }),
    } as unknown as import("../../src/agent_registry.js").AgentRegistry;
    const tm = new TaskManager(
      "n",
      broadcasterMocks.db,
      broadcasterMocks.broadcaster,
      silentLogger,
      undefined,
      contextBuilder,
      agentRegistry,
    );
    const task = await tm.createTask({
      agentSessionId: "s1",
      prompt: "p",
      profileId: "codex-default",
    });
    task.status = "completed";
    task.completedAt = new Date();
    task.codexThreadId = "thr-1";

    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "resume", user: "u" },
      onResume,
    );

    expect(result).toEqual({ autoResumed: true });
    expect(buildResumeContextItems).not.toHaveBeenCalled();
    expect(broadcasterMocks.emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "resume" }),
    );
    expect(broadcasterMocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
    expect(task.prompt).toBe("resume");
    expect(task.interventionQueue).toHaveLength(1);
  });

  it("T-1b (Phase A 실패 격리): buildResumeContextItems throw 경로를 addIntervention에서 밟지 않음", async () => {
    const broadcasterMocks = makeMocks();
    const buildResumeContextItems = vi.fn().mockRejectedValue(new Error("DB down"));
    const contextBuilder = { buildResumeContextItems } as unknown as import(
      "../../src/context/context_builder.js"
    ).ExecutionContextBuilder;
    const agentRegistry = {
      get: vi.fn().mockReturnValue({
        id: "codex-default",
        backend: "codex",
        workspace_dir: "/tmp/codex",
      }),
    } as unknown as import("../../src/agent_registry.js").AgentRegistry;
    const tm = new TaskManager(
      "n",
      broadcasterMocks.db,
      broadcasterMocks.broadcaster,
      silentLogger,
      undefined,
      contextBuilder,
      agentRegistry,
    );
    const task = await tm.createTask({
      agentSessionId: "s1",
      prompt: "p",
      profileId: "codex-default",
    });
    task.status = "completed";

    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "resume", user: "u" },
      vi.fn(),
    );

    expect(result).toEqual({ autoResumed: true });
    expect(buildResumeContextItems).not.toHaveBeenCalled();
    expect(broadcasterMocks.emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "resume" }),
    );
    expect(broadcasterMocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
  });

  it("T-1c (legacy 호환): contextBuilder 미주입 시에도 auto-resume 상태 전환은 유지", async () => {
    const broadcasterMocks = makeMocks();
    const tm = new TaskManager(
      "n",
      broadcasterMocks.db,
      broadcasterMocks.broadcaster,
      silentLogger,
      // persistence/contextBuilder/agentRegistry 모두 undefined
    );
    const task = await tm.createTask({
      agentSessionId: "s1",
      prompt: "p",
      profileId: "codex-default",
    });
    task.status = "completed";

    await tm.addIntervention(
      { agentSessionId: "s1", text: "resume", user: "u" },
      vi.fn(),
    );

    expect(broadcasterMocks.emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "resume" }),
    );
    expect(broadcasterMocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
    expect(task.prompt).toBe("resume");
  });

  it.each(["error", "interrupted"] as const)("%s task → 같은 auto-resume 경로", async (status) => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = status;
    task.error = status === "error" ? "prior error" : undefined;
    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      onResume,
    );
    expect(result).toEqual({ autoResumed: true });
    expect(task.status).toBe("running");
    expect(task.error).toBeUndefined();
    expect(onResume).toHaveBeenCalledWith(task);
  });

  it("미존재 task → throw 'Task not found'", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const onResume = vi.fn();
    await expect(
      tm.addIntervention({ agentSessionId: "missing", text: "x", user: "u" }, onResume),
    ).rejects.toThrow("Task not found: missing");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("P1-1 race 보호: completed task의 executionPromise가 살아있으면 await 후 진행 (startExecution throw 차단)", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "completed";

    // _finalize 미완료 상태를 시뮬레이션 — executionPromise는 살아있고 engine도 살아있음.
    let resolveFinalize: () => void = () => undefined;
    const finalizePromise = new Promise<void>((r) => { resolveFinalize = r; });
    task.executionPromise = finalizePromise;
    const engineCloseSpy = vi.fn().mockResolvedValue(undefined);
    task.engine = { interrupt: async () => true, close: engineCloseSpy } as unknown as EnginePort;

    const onResumeCalled: Task[] = [];
    const onResume = (t: Task) => onResumeCalled.push(t);

    // addIntervention을 트리거하지만 await — finalize가 아직 끝나지 않아 await 멈춤.
    const addPromise = tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      onResume,
    );

    // 잠시 후 finalize가 끝났다고 신호 + task.engine 정리(시뮬레이션)
    setTimeout(() => {
      task.engine = undefined;
      resolveFinalize();
    }, 5);

    const result = await addPromise;
    expect(result).toEqual({ autoResumed: true });
    expect(onResumeCalled).toHaveLength(1);
    // onResume이 호출된 시점에는 task.engine이 undefined여야 startExecution이 throw하지 않음.
    expect(task.engine).toBeUndefined();
  });

  it("completed task에 stale engine만 남아도 정리 후 auto-resume한다", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "s1",
      prompt: "p",
      profileId: "codex-default",
    });
    task.status = "completed";
    task.completedAt = new Date();

    const close = vi.fn().mockResolvedValue(undefined);
    task.engine = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-work",
      execute: vi.fn(),
      interrupt: vi.fn(),
      close,
    } as unknown as EnginePort;
    task.executionPromise = undefined;

    const onResume = vi.fn((resumedTask: Task) => {
      expect(resumedTask.engine).toBeUndefined();
    });

    await expect(
      tm.addIntervention({ agentSessionId: "s1", text: "resume", user: "u" }, onResume),
    ).resolves.toEqual({ autoResumed: true });

    expect(close).toHaveBeenCalledTimes(1);
    expect(task.engine).toBeUndefined();
    expect(onResume).toHaveBeenCalledWith(task);
  });

  it("running intervention remains queued when its accepted-event broadcast fails", async () => {
    const { db, broadcaster, emitEventEnvelope } = makeMocks();
    emitEventEnvelope.mockRejectedValueOnce(new Error("ws down"));
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      onResume,
    );
    expect(result).toEqual({ queued: true, queuePosition: 1 });
    expect(task.interventionQueue).toHaveLength(1);
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "intervention_sent", text: "x" }),
    );
  });
});

// B-5: 세션-폴더 배정 정본 (Python `_assign_default_folder_and_broadcast` 정합)
describe("TaskManager.createTask — 폴더 배정 + catalog broadcast", () => {
  it("folderId 명시 → assignSessionToFolder(folderId) + emitSessionCreated(task, folderId)", async () => {
    const { db, broadcaster, assignSessionToFolder, getFolderById, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s1",
      prompt: "x",
      profileId: "codex-default",
      folderId: "folder-explicit",
    });
    expect(assignSessionToFolder).toHaveBeenCalledWith("s1", "folder-explicit");
    expect(getFolderById).not.toHaveBeenCalled();  // 명시 folder가 있으면 default lookup 안 함
    expect(emitSessionCreated.mock.calls[0][1]).toBe("folder-explicit");
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("folderId 미지정 → 기본 폴더 id 'claude' lookup + assign + emit", async () => {
    const { db, broadcaster, assignSessionToFolder, getFolderById, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s2",
      prompt: "x",
      profileId: "codex-default",
    });
    expect(getFolderById).toHaveBeenCalledWith("claude");
    expect(assignSessionToFolder).toHaveBeenCalledWith("s2", "claude");
    expect(emitSessionCreated.mock.calls[0][1]).toBe("claude");
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("folderId 미지정 + 기본 폴더 없음 → 폴더 배정·broadcast 안 함 (graceful, Python L306-307)", async () => {
    const { db, broadcaster, assignSessionToFolder, emitSessionCreated, emitCatalogUpdated, getFolderById } = makeMocks();
    getFolderById.mockResolvedValueOnce(null);
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s3",
      prompt: "x",
      profileId: "codex-default",
    });
    expect(assignSessionToFolder).not.toHaveBeenCalled();
    expect(emitSessionCreated.mock.calls[0][1]).toBeNull();
    expect(emitCatalogUpdated).not.toHaveBeenCalled();  // 폴더 배정 안 됐으면 broadcast 안 함 (Python L311 gate)
  });

  it("assignSessionToFolder throw → 격리, task 생성은 성공 (부가 기능 실패 분리)", async () => {
    const { db, broadcaster, assignSessionToFolder, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    assignSessionToFolder.mockRejectedValueOnce(new Error("db down"));
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "s4",
      prompt: "x",
      profileId: "codex-default",
      folderId: "f-x",
    });
    expect(task.agentSessionId).toBe("s4");  // task 생성 성공
    // 폴더 배정 실패 → emit에 null 전달, catalog broadcast 안 함
    expect(emitSessionCreated.mock.calls[0][1]).toBeNull();
    expect(emitCatalogUpdated).not.toHaveBeenCalled();
  });

  it("getCatalog throw → 격리 (Python L317-321 정합), task·session_created 정상 진행", async () => {
    const { db, broadcaster, getCatalog, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    getCatalog.mockRejectedValueOnce(new Error("catalog query down"));
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "s5",
      prompt: "x",
      profileId: "codex-default",
      folderId: "f-y",
    });
    expect(task.agentSessionId).toBe("s5");
    expect(emitSessionCreated.mock.calls[0][1]).toBe("f-y");  // 폴더 배정은 성공 (assign은 throw 안 함)
    expect(emitCatalogUpdated).not.toHaveBeenCalled();  // catalog 실패는 broadcast 차단
  });

  it("emitCatalogUpdated가 emitSessionCreated *이전*에 호출됨 (Python L304 순서 보장)", async () => {
    const { db, broadcaster, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s6",
      prompt: "x",
      profileId: "codex-default",
      folderId: "f",
    });
    // mock 호출 순서 검증
    const catalogOrder = emitCatalogUpdated.mock.invocationCallOrder[0];
    const createdOrder = emitSessionCreated.mock.invocationCallOrder[0];
    expect(catalogOrder).toBeLessThan(createdOrder);
  });
});

// B-5: session_broadcaster.emitCatalogUpdated wire 형상 회귀는 session_broadcaster.test.ts에서 보호.

// B-5: live surface가 없는 running task는 다음 turn queue fallback이 정본.
describe("TaskManager.addIntervention — running fallback without live surface (B-5)", () => {
  it("persistence 주입 시 live surface가 없어도 접수 이벤트를 기록한 뒤 queue에 보존", async () => {
    const mocks = makeMocks();
    const persistEvent = vi.fn().mockResolvedValue(123);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { persistEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;

    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    expect(task.status).toBe("running");

    await tm.addIntervention(
      { agentSessionId: "s1", text: "추가 메시지", user: "alice", callerInfo: { source: "slack" } },
      vi.fn(),
    );

    expect(task.interventionQueue).toEqual([
      {
        text: "추가 메시지",
        user: "alice",
        callerInfo: { source: "slack" },
      },
    ]);
    expect(persistEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "intervention_sent", text: "추가 메시지" }),
    );
    expect(handleSideEffects).toHaveBeenCalledTimes(1);
    expect(
      mocks.emitEventEnvelope.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === "intervention_sent",
      ),
    ).toHaveLength(1);
    expect(task.lastEventId).toBe(123);
  });

  it("persistence 미주입(legacy) + live surface 없음 → 접수 wire를 발행하고 queue에 보존", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);  // persistence 생략
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      vi.fn(),
    );
    expect(task.interventionQueue).toEqual([{ text: "x", user: "u" }]);
    expect(
      mocks.emitEventEnvelope.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === "intervention_sent",
      ),
    ).toHaveLength(1);
  });

  it("persistEvent 실패 시 running intervention을 queue에 넣지 않고 실패를 반환", async () => {
    const mocks = makeMocks();
    const persistEvent = vi.fn().mockRejectedValueOnce(new Error("events db down"));
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { persistEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    await expect(
      tm.addIntervention(
        { agentSessionId: "s1", text: "x", user: "u" },
        vi.fn(),
      ),
    ).rejects.toThrow("events db down");
    expect(task.interventionQueue).toEqual([]);
    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(
      mocks.emitEventEnvelope.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === "intervention_sent",
      ),
    ).toHaveLength(0);
  });
});

// PR #55: 결함 A·B 정합 (resume vs intervention 분기 + typing indicator)
describe("TaskManager.addIntervention — running vs completed wire 분기 (결함 A·B)", () => {
  it("running task without live surface → intervention_sent 접수 후 queue fallback", async () => {
    const mocks = makeMocks();
    const persistEvent = vi.fn().mockResolvedValue(1);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { persistEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    expect(task.status).toBe("running");

    await tm.addIntervention(
      { agentSessionId: "s1", text: "추가", user: "u" },
      vi.fn(),
    );

    const envelopeCalls = mocks.emitEventEnvelope.mock.calls;
    expect(envelopeCalls).toEqual([
      ["s1", expect.objectContaining({ type: "intervention_sent", text: "추가" })],
    ]);
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(task.interventionQueue).toEqual([{ text: "추가", user: "u" }]);
  });

  it("completed task → user_message 접수 후 session_updated + onResume", async () => {
    const mocks = makeMocks();
    const persistEvent = vi.fn().mockResolvedValue(2);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { persistEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "completed";
    task.completedAt = new Date();

    await tm.addIntervention(
      { agentSessionId: "s1", text: "이어서", user: "alice", callerInfo: { source: "slack", display_name: "Alice" } },
      vi.fn(),
    );

    const envelopeCalls = mocks.emitEventEnvelope.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(envelopeCalls.length).toBe(1);
    expect(envelopeCalls[0]?.[1]).toEqual(
      expect.objectContaining({ type: "user_message", text: "이어서", _event_id: 2 }),
    );
    expect(persistEvent).toHaveBeenCalledTimes(1);

    // session_updated가 status="running" 박힌 task로 broadcast (결함 B fix)
    expect(mocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
    const updatedTask = mocks.emitSessionUpdated.mock.calls[0][0] as Task;
    expect(updatedTask.status).toBe("running");
    expect(updatedTask.prompt).toBe("이어서");
    expect(updatedTask.clientId).toBe("alice");
    expect(updatedTask.callerInfo).toEqual({ source: "slack", display_name: "Alice" });
    expect(updatedTask.metadata).toContainEqual({
      type: "caller_info",
      value: { source: "slack", display_name: "Alice" },
    });
    expect(mocks.appendMetadata).toHaveBeenCalledWith("s1", {
      type: "caller_info",
      value: { source: "slack", display_name: "Alice" },
    });

    // intervention_sent는 발행 안 함
    expect(
      mocks.emitEventEnvelope.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === "intervention_sent",
      ),
    ).toHaveLength(0);
  });

  it.each(["error", "interrupted"] as const)("%s task → auto-resume 상태 전환 (completed와 동일)", async (status) => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = status;
    await tm.addIntervention(
      { agentSessionId: "s1", text: "재개", user: "u" },
      vi.fn(),
    );
    const envelopeCalls = mocks.emitEventEnvelope.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(envelopeCalls.length).toBe(1);
    expect(
      mocks.emitEventEnvelope.mock.calls.filter(
        (c) => (c[1] as { type: string }).type === "intervention_sent",
      ),
    ).toHaveLength(0);
    expect(mocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
  });

  it("auto-resume addIntervention은 user_message와 session_updated를 즉시 발행", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "completed";
    await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      vi.fn(),
    );
    expect(mocks.emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "x" }),
    );
    expect(mocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
  });
});

// PR #56: 결함 D — 서버 재기동 후 task hydration (Python load_evicted_task 정합)
describe("TaskManager.addIntervention — 메모리 비어 있을 때 DB hydration (결함 D)", () => {
  it("메모리에 task가 없고 DB에도 없으면 throw (현 동작 보존)", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce(null);
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await expect(
      tm.addIntervention({ agentSessionId: "missing", text: "x", user: "u" }, vi.fn()),
    ).rejects.toThrow("Task not found: missing");
    expect(mocks.getSession).toHaveBeenCalledWith("missing");
  });

  it("DB row가 다른 노드 소유이면 owner mismatch를 Task not found와 구분해 보고", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "caller-owned-elsewhere",
      folder_id: "f-owner",
      display_name: null,
      node_id: "owner-node",
      session_type: "claude",
      status: "completed",
      prompt: "caller prompt",
      client_id: null,
      claude_session_id: "thread-owner-node",
      last_message: null,
      metadata: null,
      was_running_at_shutdown: false,
      last_event_id: 42,
      last_read_event_id: 10,
      created_at: new Date("2026-05-25T01:00:00Z"),
      updated_at: new Date("2026-05-25T01:05:00Z"),
      agent_id: "codex-default",
      caller_session_id: null,
      away_summary: null,
    });
    const tm = new TaskManager("reporting-node", mocks.db, mocks.broadcaster, silentLogger);
    const onResume = vi.fn();

    await expect(
      tm.addIntervention(
        {
          agentSessionId: "caller-owned-elsewhere",
          text: "remote child completion report",
          user: "agent",
          callerInfo: { source: "agent", agent_node: "reporting-node" },
        },
        onResume,
      ),
    ).rejects.toThrow(
      "Task owned by another node: caller-owned-elsewhere owner=owner-node current=reporting-node",
    );

    expect(mocks.getSession).toHaveBeenCalledWith("caller-owned-elsewhere");
    expect(tm.getTask("caller-owned-elsewhere")).toBeUndefined();
    expect(mocks.appendMetadata).not.toHaveBeenCalled();
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("메모리에 task가 없고 DB에 completed 세션이 있으면 hydrate + auto-resume 흐름 진입", async () => {
    const mocks = makeMocks();
    // DB row 반환 — codex 세션 (claude_session_id가 codex thread id)
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-evicted",
      folder_id: "f-1",
      display_name: null,
      node_id: "n",
      session_type: "claude",
      status: "completed",
      prompt: "원래 prompt",
      client_id: null,
      claude_session_id: "thr-codex-abc",  // codex thread id (PR #48 F-3B)
      last_message: null,
      metadata: null,
      was_running_at_shutdown: false,
      last_event_id: 42,
      last_read_event_id: 10,
      created_at: new Date("2026-05-17T10:00:00Z"),
      updated_at: new Date("2026-05-17T10:05:00Z"),
      agent_id: "codex-default",
      caller_session_id: null,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);

    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "sess-evicted", text: "이어서", user: "u" },
      onResume,
    );

    // auto-resume 흐름 진입
    expect(result).toEqual({ autoResumed: true });
    // hydrate된 task가 메모리에 추가됨
    const memTask = tm.getTask("sess-evicted");
    expect(memTask).toBeDefined();
    expect(memTask!.status).toBe("running");  // auto-resume에서 전환
    expect(memTask!.codexThreadId).toBe("thr-codex-abc");  // resumeThread를 위해 복원
    expect(memTask!.profileId).toBe("codex-default");
    expect(memTask!.prompt).toBe("이어서");
    expect(memTask!.lastEventId).toBe(42);
    const userMsgCalls = mocks.emitEventEnvelope.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(userMsgCalls.length).toBe(1);
    expect(userMsgCalls[0]?.[1]).toEqual(
      expect.objectContaining({ type: "user_message", text: "이어서" }),
    );
    expect(mocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-evicted", {
      status: "running",
      last_event_id: memTask!.lastEventId,
      termination_reason: null,
      termination_detail: null,
      review_state: "not_required",
    });
    expect(onResume).toHaveBeenCalledWith(memTask);
  });

  it("DB completed Claude row는 hydrate 후 기존 Claude session id로 auto-resume 흐름 진입", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-evicted-claude",
      folder_id: "f-1",
      display_name: null,
      node_id: "n",
      session_type: "claude",
      status: "completed",
      prompt: "original prompt",
      client_id: null,
      claude_session_id: "736ddf46-4c72-4b02-a44a-fab3e5e58fe5",
      last_message: null,
      metadata: null,
      was_running_at_shutdown: false,
      last_event_id: 581,
      last_read_event_id: 580,
      created_at: new Date("2026-06-07T16:00:00Z"),
      updated_at: new Date("2026-06-07T16:15:00Z"),
      agent_id: "claude-roselin",
      caller_session_id: null,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const onResume = vi.fn();

    const result = await tm.addIntervention(
      { agentSessionId: "sess-evicted-claude", text: "resume from last event", user: "browser" },
      onResume,
    );

    expect(result).toEqual({ autoResumed: true });
    expect(mocks.getSession).toHaveBeenCalledWith("sess-evicted-claude");
    const memTask = tm.getTask("sess-evicted-claude");
    expect(memTask).toBeDefined();
    expect(memTask!.status).toBe("running");
    expect(memTask!.profileId).toBe("claude-roselin");
    expect(memTask!.sessionType).toBe("claude");
    expect(memTask!.codexThreadId).toBe("736ddf46-4c72-4b02-a44a-fab3e5e58fe5");
    expect(memTask!.lastEventId).toBe(581);
    expect(memTask!.lastReadEventId).toBe(580);
    expect(memTask!.prompt).toBe("resume from last event");
    expect(mocks.emitEventEnvelope).toHaveBeenCalledWith(
      "sess-evicted-claude",
      expect.objectContaining({
        type: "user_message",
        text: "resume from last event",
      }),
    );
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-evicted-claude", {
      status: "running",
      last_event_id: memTask!.lastEventId,
      termination_reason: null,
      termination_detail: null,
      review_state: "not_required",
    });
    expect(onResume).toHaveBeenCalledWith(memTask);
  });

  it("DB running row without active execution is auto-resumed instead of queued", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-stale-running",
      session_type: "claude",
      status: "running",
      prompt: "p",
      claude_session_id: "thr-stale",
      last_event_id: 5,
      last_read_event_id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      agent_id: "codex-default",
      caller_session_id: null,
      folder_id: null,
      display_name: null,
      node_id: "n",
      client_id: null,
      last_message: null,
      metadata: null,
      was_running_at_shutdown: false,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const onResume = vi.fn();

    const result = await tm.addIntervention(
      { agentSessionId: "sess-stale-running", text: "resume", user: "u" },
      onResume,
    );

    expect(result).toEqual({ autoResumed: true });
    const memTask = tm.getTask("sess-stale-running");
    expect(memTask).toBeDefined();
    expect(memTask!.status).toBe("running");
    expect(memTask!.codexThreadId).toBe("thr-stale");
    expect(mocks.emitEventEnvelope).toHaveBeenCalledWith(
      "sess-stale-running",
      expect.objectContaining({ type: "user_message", text: "resume" }),
    );
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalledWith(
      "sess-stale-running",
      expect.objectContaining({ type: "intervention_sent" }),
    );
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-stale-running", {
      status: "running",
      last_event_id: memTask!.lastEventId,
      termination_reason: null,
      termination_detail: null,
      review_state: "not_required",
    });
    expect(onResume).toHaveBeenCalledWith(memTask);
  });

  it.each(["error", "interrupted"] as const)("DB에 %s 세션도 hydrate 가능 (terminal 모두)", async (status) => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-t",
      session_type: "claude",
      status,
      prompt: "p",
      claude_session_id: "thr-x",
      last_event_id: 5,
      last_read_event_id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      agent_id: "codex-default",
      caller_session_id: null,
      folder_id: null,
      display_name: null,
      node_id: "n",
      client_id: null,
      last_message: null,
      metadata: null,
      was_running_at_shutdown: false,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const result = await tm.addIntervention(
      { agentSessionId: "sess-t", text: "재개", user: "u" },
      vi.fn(),
    );
    expect(result).toEqual({ autoResumed: true });
    expect(tm.getTask("sess-t")!.status).toBe("running");
  });

  it("DB row.status가 비정상 값이면 null 반환 → throw (graceful)", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-bad",
      session_type: "claude",
      status: "invalid_status",  // 비정상
      prompt: "p",
      claude_session_id: null,
      last_event_id: 0,
      last_read_event_id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      agent_id: null,
      caller_session_id: null,
      folder_id: null,
      display_name: null,
      node_id: null,
      client_id: null,
      last_message: null,
      metadata: null,
      was_running_at_shutdown: false,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await expect(
      tm.addIntervention({ agentSessionId: "sess-bad", text: "x", user: "u" }, vi.fn()),
    ).rejects.toThrow("Task not found: sess-bad");
  });

  it("db.getSession throw → hydration failure로 명시적 실패", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockRejectedValueOnce(new Error("db connection lost"));
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await expect(
      tm.addIntervention({ agentSessionId: "sess-x", text: "x", user: "u" }, vi.fn()),
    ).rejects.toThrow("Task hydration failed: sess-x");
  });

  it("메모리에 task가 있으면 hydration skip (기존 동작 보존)", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    expect(tm.getTask("s1")).toBeDefined();
    await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      vi.fn(),
    );
    // 메모리 hit이라 getSession 호출 안 됨
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("hydrate가 metadata JSONB array에서 마지막 신원 박힌 caller_info를 복원 (R-2 회로 차단)", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-r2",
      session_type: "claude",
      status: "completed",
      prompt: "p",
      claude_session_id: "thr-r2",
      last_event_id: 0,
      last_read_event_id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      agent_id: "codex-default",
      caller_session_id: null,
      folder_id: null,
      display_name: null,
      node_id: "n",
      client_id: null,
      last_message: null,
      // 신원 박힌 entry (소우/source=slack)와 빈 신원 entry 혼합 → 마지막 신원 박힌 것 선택
      metadata: [
        { type: "caller_info", value: { source: "browser", display_name: "옛 신원" } },
        { type: "caller_info", value: { source: "slack", display_name: "Alice" } },
        { type: "caller_info", value: {} },  // 빈 dict — 마지막이지만 신원 없음
      ],
      was_running_at_shutdown: false,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await tm.addIntervention(
      { agentSessionId: "sess-r2", text: "x", user: "u" },
      vi.fn(),
    );
    const task = tm.getTask("sess-r2")!;
    expect(task.callerInfo).toEqual({ source: "slack", display_name: "Alice" });
  });

  it("hydrate가 metadata에 caller_info entry 0건이면 callerInfo undefined", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-empty",
      session_type: "claude",
      status: "completed",
      prompt: "p",
      claude_session_id: null,
      last_event_id: 0,
      last_read_event_id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      agent_id: null,
      caller_session_id: null,
      folder_id: null,
      display_name: null,
      node_id: null,
      client_id: null,
      last_message: null,
      metadata: [{ type: "other", value: { something: "else" } }],
      was_running_at_shutdown: false,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await tm.addIntervention(
      { agentSessionId: "sess-empty", text: "x", user: "u" },
      vi.fn(),
    );
    const task = tm.getTask("sess-empty")!;
    expect(task.callerInfo).toBeUndefined();
  });

  it("hydrate가 IDENTITY_BEARING_SOURCES(agent/system/...) 신원 필드 비어도 신원 박힘으로 인정 (Python has_caller_identity 정본)", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-agent",
      session_type: "claude",
      status: "completed",
      prompt: "p",
      claude_session_id: null,
      last_event_id: 0,
      last_read_event_id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      agent_id: "codex-default",
      caller_session_id: null,
      folder_id: null,
      display_name: null,
      node_id: "n",
      client_id: null,
      last_message: null,
      metadata: [
        { type: "caller_info", value: { source: "agent", agent_id: "roselin" } },  // 신원 박힘 (source가 IDENTITY_BEARING)
        { type: "caller_info", value: { source: "browser" } },  // browser는 IDENTITY_BEARING 아님 + 필드 비어 신원 없음
      ],
      was_running_at_shutdown: false,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await tm.addIntervention(
      { agentSessionId: "sess-agent", text: "x", user: "u" },
      vi.fn(),
    );
    const task = tm.getTask("sess-agent")!;
    // 정책 1 (마지막 신원 박힌 entry) → agent entry. browser는 신원 없음으로 제외.
    expect(task.callerInfo).toEqual({ source: "agent", agent_id: "roselin" });
  });

  it("hydrate된 task의 첫 turn이 queue dequeue로 진입 (PR #54 P0 fix와 정합)", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-h",
      session_type: "claude",
      status: "completed",
      prompt: "원래",
      claude_session_id: "thr-h",
      last_event_id: 3,
      last_read_event_id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      agent_id: "codex-default",
      caller_session_id: null,
      folder_id: null,
      display_name: null,
      node_id: "n",
      client_id: null,
      last_message: null,
      metadata: null,
      was_running_at_shutdown: false,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await tm.addIntervention(
      { agentSessionId: "sess-h", text: "새 메시지", user: "u" },
      vi.fn(),
    );
    const task = tm.getTask("sess-h")!;
    // Python parity: auto-resume 메시지가 새 task prompt로 승격되고 queue 첫 turn으로 실행됨.
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.interventionQueue[0].text).toBe("새 메시지");
    expect(task.prompt).toBe("새 메시지");
  });
});
