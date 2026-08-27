import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile, AgentRegistry } from "../../src/agent_registry.js";
import type { BoardYjsHostClient } from "../../src/collaboration/board_yjs_host_client.js";
import type { SessionMutationHost } from "../../src/control_plane/persistence_host_clients.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EnginePort,
  SupportsToolApproval,
} from "../../src/engine/protocol.js";
import { createInProcessTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type {
  AddInterventionParams,
  AddInterventionResult,
  StartExecutionCallback,
} from "../../src/task/task_intervention_route.js";
import { TaskManager as ProductionTaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

type BoardYjsService = Pick<BoardYjsHostClient, "upsertSessionBoardItem">;

const boardYjsServices = new WeakMap<SessionDB, BoardYjsService>();

const activationHarnessAgent: AgentProfile = {
  id: "task-manager-activation-harness",
  name: "TaskManager activation harness",
  backend: "codex",
  workspace_dir: "/tmp/task-manager-activation-harness",
};

function makeActivationHarnessEngine(): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: activationHarnessAgent.workspace_dir,
    async *execute() {
      await new Promise<void>(() => undefined);
    },
    async intervene() {
      return {
        status: "not_delivered",
        mechanism: "interrupt_then_next_turn",
        reason: "next_turn_required",
      };
    },
    async interrupt() { return true; },
    async close() {},
  };
}

function legacyMutationHost(db: SessionDB): SessionMutationHost {
  const legacy = db as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  return {
    registerSession: async (params) => await legacy.registerSession(params),
    transitionSession: async (sessionId, fields) =>
      await legacy.updateSession(sessionId, fields),
    renameSession: async (sessionId, displayName) =>
      await legacy.renameSession(sessionId, displayName),
    deleteSession: async (sessionId) => await legacy.deleteSession(sessionId),
    acknowledgeReview: async (sessionId) =>
      await legacy.acknowledgeSessionReview(sessionId) as never,
  };
}

class TaskManager extends ProductionTaskManager {
  private readonly activationExecutor?: TaskExecutor;

  constructor(...args: ConstructorParameters<typeof ProductionTaskManager>) {
    args[7] ??= boardYjsServices.get(args[1]);
    args[12] ??= legacyMutationHost(args[1]);
    super(...args);
    if (args[4]) {
      this.activationExecutor = new TaskExecutor(
        makeActivationHarnessEngine,
        args[1],
        args[4],
        args[2],
        silentLogger,
      );
    }
  }

  override addIntervention(
    params: AddInterventionParams,
    observeResume: StartExecutionCallback,
  ): Promise<AddInterventionResult> {
    return super.addIntervention(params, (task, activation) => {
      observeResume(task);
      if (!activation) return;
      if (!this.activationExecutor) {
        throw new Error("activation harness requires event persistence");
      }
      return this.activationExecutor.startExecution(
        task,
        activationHarnessAgent,
        activation,
      );
    });
  }
}

function makeMocks() {
  const persistenceDouble = makeEventPersistenceTestDouble();
  const registerSession = vi.fn().mockResolvedValue(undefined);
  const appendMetadata = vi.fn().mockResolvedValue(1);
  const deleteSession = vi.fn().mockResolvedValue(undefined);
  const updateSession = vi.fn().mockResolvedValue(undefined);
  const acknowledgeSessionReview = vi.fn().mockResolvedValue("acknowledged");
  // B-5: 폴더 배정 정본은 Board Y.Doc 원자 배치다.
  const getFolderById = vi
    .fn()
    .mockResolvedValue({
      id: "claude",
      name: "사용자가 바꾼 클로드 폴더 이름",
      sort_order: 0,
      settings: {},
      parent_folder_id: null,
    });
  const getAllFolders = vi.fn().mockResolvedValue([]);
  const getPrimarySessionBoardItem = vi.fn().mockResolvedValue(null);
  const getBoardItems = vi.fn().mockResolvedValue([]);
  const upsertSessionBoardItem = vi.fn().mockResolvedValue({});
  // PR #56: hydration mock (Python load_evicted_task 정합)
  const getSession = vi.fn().mockResolvedValue(null);
  const db = {
    registerSession,
    appendMetadata,
    deleteSession,
    updateSession,
    acknowledgeSessionReview,
    getFolderById,
    getAllFolders,
    getPrimarySessionBoardItem,
    getBoardItems,
    getSession,
  } as unknown as SessionDB;
  boardYjsServices.set(db, { upsertSessionBoardItem });
  (persistenceDouble.persistence as unknown as {
    enqueueMetadataEffect: typeof appendMetadata;
  }).enqueueMetadataEffect = appendMetadata;

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
    persistence: persistenceDouble.persistence,
    enqueueEvent: persistenceDouble.enqueueEvent,
    enqueueEventAndWaitForSessionAck:
      persistenceDouble.enqueueEventAndWaitForSessionAck,
    enqueueTerminalTransitionAndWaitForApplication:
      persistenceDouble.enqueueTerminalTransitionAndWaitForApplication,
    acquireExecutionOwnershipAndWaitForApplication:
      persistenceDouble.acquireExecutionOwnershipAndWaitForApplication,
    enqueueRunningTransition: persistenceDouble.enqueueRunningTransition,
    db,
    broadcaster,
    registerSession,
    appendMetadata,
    deleteSession,
    updateSession,
    acknowledgeSessionReview,
    getFolderById,
    getAllFolders,
    getPrimarySessionBoardItem,
    getBoardItems,
    upsertSessionBoardItem,
    getSession,
    emitSessionCreated,
    emitSessionDeleted,
    emitCatalogUpdated,
    emitEventEnvelope,
    emitSessionUpdated,
  };
}

describe("TaskManager model preset defaults", () => {
  it("resolves a profile default before persisting a task created outside upstream commands", async () => {
    const mocks = makeMocks();
    const agentRegistry = {
      get: vi.fn(() => ({
        id: "roselin",
        name: "로젤린",
        backend: "claude",
        default_preset: "codex-5.6-sol",
        workspace_dir: "/tmp/roselin",
      })),
    } as unknown as AgentRegistry;
    const modelCatalog = {
      resolve: vi.fn(() => ({
        id: "codex-5.6-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex" as const,
        model: "gpt-5.6-sol",
      })),
    };
    const tm = new TaskManager(
      "n",
      mocks.db,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      agentRegistry,
      undefined,
      undefined,
      false,
      undefined,
      modelCatalog,
    );

    const task = await tm.createTask({
      agentSessionId: "sess-default-preset",
      prompt: "inspect",
      profileId: "roselin",
    });

    expect(task).toMatchObject({
      modelPreset: "codex-5.6-sol",
      model: "gpt-5.6-sol",
      modelPresetBackend: "codex",
    });
    expect(mocks.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPreset: "codex-5.6-sol",
        model: "gpt-5.6-sol",
      }),
    );
  });

  it("persists the canonical profile while preserving an alias-specific default preset", async () => {
    const mocks = makeMocks();
    const agentRegistry = {
      get: vi.fn((id: string) =>
        id === "roselin-opus"
          ? {
              id: "roselin",
              name: "로젤린",
              backend: "claude",
              default_preset: "claude-opus",
              workspace_dir: "/tmp/roselin",
            }
          : undefined,
      ),
    } as unknown as AgentRegistry;
    const modelCatalog = {
      resolve: vi.fn(() => ({
        id: "claude-opus",
        label: "Claude Opus",
        backend: "claude" as const,
        model: "claude-opus-4-6",
      })),
    };
    const tm = new TaskManager(
      "n",
      mocks.db,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      agentRegistry,
      undefined,
      undefined,
      false,
      undefined,
      modelCatalog,
    );

    const task = await tm.createTask({
      agentSessionId: "sess-alias-preset",
      prompt: "inspect",
      profileId: "roselin-opus",
    });

    expect(task).toMatchObject({
      profileId: "roselin",
      modelPreset: "claude-opus",
      model: "claude-opus-4-6",
      modelPresetBackend: "claude",
    });
    expect(mocks.registerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "roselin",
        modelPreset: "claude-opus",
      }),
    );
  });
});

describe("TaskManager.acknowledgeReview", () => {
  it("applies the atomic DB outcome to memory and broadcasts the acknowledged state", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);

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
      const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);

      await expect(tm.acknowledgeReview("sess-review-error")).resolves.toBe(outcome);

      expect(mocks.getSession).toHaveBeenCalledWith("sess-review-error");
      expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
    },
  );
});

describe("TaskManager.createTask", () => {
  it("Task 생성 + DB registerSession + caller_info metadata + broadcast session_created", async () => {
    const {
      db,
      broadcaster,
      persistence,
      registerSession,
      appendMetadata,
      upsertSessionBoardItem,
      emitSessionCreated,
    } = makeMocks();
    const tm = new TaskManager(
      "eias-shopping-ts",
      db,
      broadcaster,
      silentLogger,
      persistence,
    );

    const task = await tm.createTask({
      agentSessionId: "sess-1",
      prompt: "hi",
      profileId: "codex-default",
      callerInfo: { source: "slack" },
    });

    expect(task.agentSessionId).toBe("sess-1");
    expect(task.status).toBe("initializing");
    expect(task.profileId).toBe("codex-default");
    expect(task.createdAt).toBeInstanceOf(Date);

    expect(registerSession).toHaveBeenCalledTimes(1);
    const regArg = registerSession.mock.calls[0][0];
    expect(regArg.sessionId).toBe("sess-1");
    expect(regArg.nodeId).toBe("eias-shopping-ts");
    expect(regArg.agentId).toBe("codex-default");
    expect(regArg.sessionType).toBe("claude");
    expect(regArg.status).toBe("initializing");
    expect(appendMetadata).toHaveBeenCalledWith(
      "sess-1",
      {
        type: "caller_info",
        value: { source: "slack" },
      },
      { waitForAck: true },
    );
    expect(task.metadata).toEqual([
      { type: "caller_info", value: { source: "slack" } },
    ]);
    expect(upsertSessionBoardItem).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "claude",
      container: { containerKind: "folder", containerId: "claude" },
      sessionId: "sess-1",
      sourceTaskItemId: null,
    }));

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

  it("folderId 전달 시 해당 폴더 Y.Doc 배치 뒤 session_created에 그대로 박힘", async () => {
    const { db, broadcaster, upsertSessionBoardItem, emitSessionCreated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s1",
      prompt: "x",
      profileId: "a",
      folderId: "folder-42",
    });
    expect(upsertSessionBoardItem).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "folder-42",
      container: { containerKind: "folder", containerId: "folder-42" },
      sessionId: "s1",
    }));
    expect(emitSessionCreated.mock.calls[0][1]).toBe("folder-42");
  });
});

describe("TaskManager.deliverToolApproval", () => {
  it("running task의 tool approval reject를 engine capability에 전달하고 resolved SSE를 남김", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({
      agentSessionId: "sess-approval",
      prompt: "dangerous tool",
      profileId: "agent-openai",
    });
    task.status = "running";
    const deliverToolApproval = vi.fn().mockResolvedValue({ status: "delivered" });
    task.runner = createInProcessTaskRunnerRuntime({
      backendId: "openai-agents",
      workspaceDir: "/tmp/agents",
      async *execute(): AsyncIterable<never> {},
      async interrupt() { return true; },
      async close() {},
      deliverToolApproval,
    } as EnginePort & SupportsToolApproval);

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
    expect(mocks.enqueueEventAndWaitForSessionAck).toHaveBeenCalledWith(
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
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("tool approval capability가 없으면 input_request respond와 별도로 not_supported를 반환", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "sess-no-approval",
      prompt: "dangerous tool",
      profileId: "codex-default",
    });
    task.status = "running";
    task.runner = createInProcessTaskRunnerRuntime({
      backendId: "codex",
      workspaceDir: "/tmp/codex",
      async *execute(): AsyncIterable<never> {},
      async interrupt() { return true; },
      async close() {},
    } as EnginePort);

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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);

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
    const enqueueEvent = vi.fn().mockResolvedValue(99);
    const enqueueEventAndWaitForSessionAck = vi.fn().mockResolvedValue({
      record: { source_seq: 99 },
      eventId: 99,
    });
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = {
      enqueueEvent,
      enqueueEventAndWaitForSessionAck,
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
    expect(enqueueEventAndWaitForSessionAck).toHaveBeenCalledWith(
      "sess-evicted-approval",
      expect.objectContaining({ type: "tool_approval_resolved" }),
    );
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    const enqueueEvent = vi.fn().mockResolvedValue(77);
    const enqueueEventAndWaitForSessionAck = vi.fn().mockResolvedValue({
      record: { source_seq: 77 },
      eventId: 77,
    });
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = {
      enqueueEvent,
      enqueueEventAndWaitForSessionAck,
      handleSideEffects,
    } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({
      agentSessionId: "sess-ask",
      prompt: "p",
      profileId: "claude-roselin",
    });
    task.status = "running";
    const deliverInputResponse = vi.fn().mockResolvedValue({ status: "delivered" });
    task.runner = createInProcessTaskRunnerRuntime({
      backendId: "claude",
      workspaceDir: "/tmp/claude",
      deliverInputResponse,
      async *execute() {},
      async interrupt() { return true; },
      async close() {},
    } as unknown as EnginePort);

    const result = await tm.deliverInputResponse({
      agentSessionId: "sess-ask",
      requestId: "ask-1",
      answers: { choice: "yes" },
    });

    expect(result).toEqual({ status: "delivered", requestId: "ask-1", eventId: 77 });
    expect(deliverInputResponse).toHaveBeenCalledWith("ask-1", { choice: "yes" });
    expect(enqueueEventAndWaitForSessionAck).toHaveBeenCalledWith("sess-ask", expect.objectContaining({
      type: "input_request_responded",
      request_id: "ask-1",
    }));
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
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
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const persistence = {
      enqueueEvent,
      handleSideEffects: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "sess-ask", prompt: "p", profileId: "claude-roselin" });
    task.status = "running";
    task.runner = createInProcessTaskRunnerRuntime({
      backendId: "claude",
      workspaceDir: "/tmp/claude",
      deliverInputResponse: vi.fn().mockResolvedValue({ status: engineStatus }),
      async *execute() {},
      async interrupt() { return true; },
      async close() {},
    } as unknown as EnginePort);
    enqueueEvent.mockClear();

    const result = await tm.deliverInputResponse({
      agentSessionId: "sess-ask",
      requestId: "ask-1",
      answers: { choice: "yes" },
    });

    expect(result.status).toBe(expectedStatus);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("missing session → session_not_found", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);

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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({ agentSessionId: "sess-codex", prompt: "p", profileId: "codex-default" });
    task.status = "running";
    task.runner = createInProcessTaskRunnerRuntime({
      backendId: "codex",
      workspaceDir: "/tmp/codex",
      async *execute() {},
      async interrupt() { return true; },
      async close() {},
    } as unknown as EnginePort);

    await expect(tm.deliverInputResponse({
      agentSessionId: "sess-codex",
      requestId: "ask-1",
      answers: {},
    })).resolves.toMatchObject({
      status: "not_supported",
      backend: "codex",
    });
  });

  it("gate OFF ignores an injected session registry without touching it", async () => {
    const mocks = makeMocks();
    const sessionRuntimeControl = {
      has: vi.fn().mockReturnValue(true),
      close: vi.fn().mockResolvedValue(true),
      deliverInputResponse: vi.fn().mockResolvedValue({ status: "delivered" }),
      backgroundClaudeRuntimeTasks: vi.fn().mockResolvedValue({ status: "ok" }),
      stopClaudeRuntimeTask: vi.fn().mockResolvedValue({ status: "ok" }),
    };
    const tm = new TaskManager(
      "n",
      mocks.db,
      mocks.broadcaster,
      silentLogger,
      mocks.persistence,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      sessionRuntimeControl,
    );
    const task = await tm.createTask({
      agentSessionId: "sess-gate-off",
      prompt: "done",
      profileId: "claude-roselin",
    });
    task.status = "completed";

    await expect(tm.deliverInputResponse({
      agentSessionId: task.agentSessionId,
      requestId: "ask-late",
      answers: {},
    })).resolves.toMatchObject({
      status: "session_not_running",
    });
    await expect(tm.cancelTask(task.agentSessionId)).resolves.toBe(true);

    expect(sessionRuntimeControl.has).not.toHaveBeenCalled();
    expect(sessionRuntimeControl.deliverInputResponse).not.toHaveBeenCalled();
    expect(sessionRuntimeControl.close).not.toHaveBeenCalled();
  });

  it("gate ON routes completed-session input and explicit reclaim through the registry", async () => {
    const mocks = makeMocks();
    Object.assign(mocks.db, {
      sessionDeliveries: vi.fn().mockReturnValue({}),
    });
    const sessionRuntimeControl = {
      has: vi.fn().mockReturnValue(true),
      close: vi.fn().mockResolvedValue(true),
      deliverInputResponse: vi.fn().mockResolvedValue({ status: "delivered" }),
      backgroundClaudeRuntimeTasks: vi.fn().mockResolvedValue({ status: "ok" }),
      stopClaudeRuntimeTask: vi.fn().mockResolvedValue({ status: "ok" }),
    };
    const tm = new TaskManager(
      "n",
      mocks.db,
      mocks.broadcaster,
      silentLogger,
      mocks.persistence,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      sessionRuntimeControl,
    );
    const task = await tm.createTask({
      agentSessionId: "sess-gate-on",
      prompt: "done",
      profileId: "claude-roselin",
    });
    task.status = "completed";

    await expect(tm.deliverInputResponse({
      agentSessionId: task.agentSessionId,
      requestId: "ask-late",
      answers: { choice: "continue" },
    })).resolves.toMatchObject({ status: "delivered" });
    await expect(tm.cancelTask(task.agentSessionId)).resolves.toBe(true);

    expect(sessionRuntimeControl.deliverInputResponse).toHaveBeenCalledWith(
      task.agentSessionId,
      "ask-late",
      { choice: "continue" },
    );
    expect(sessionRuntimeControl.close).toHaveBeenCalledWith(
      task.agentSessionId,
      "explicit_cancel",
    );
  });
});

describe("TaskManager.finalizeTask", () => {
  it("result finalize → completed 상태와 usage를 기록하고 session_updated를 발행", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "session_ended", status: "completed" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "completed",
        termination_reason: "completed_ok",
      }),
    );
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
  });

  it("error finalize → error 상태와 message를 기록하고 stale result를 지움", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    task.result = "old";

    await tm.finalizeTask({ agentSessionId: "s1", error: "boom" });

    expect(task.status).toBe("error");
    expect(task.error).toBe("boom");
    expect(task.result).toBeUndefined();
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "session_ended", status: "error" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "error",
        termination_reason: "unknown",
      }),
    );
  });

  it("terminal event+effect 원자 적용 실패는 finalize를 실패시킴", async () => {
    const mocks = makeMocks();
    mocks.enqueueTerminalTransitionAndWaitForApplication.mockRejectedValueOnce(
      new Error("ingress down"),
    );
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });

    await expect(tm.finalizeTask({
      agentSessionId: "s1",
      result: "done",
    })).rejects.toThrow("ingress down");

    expect(task.status).toBe("completed");
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
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
    const { db, broadcaster, persistence } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    const interrupt = vi.fn().mockResolvedValue(true);
    task.runner = createInProcessTaskRunnerRuntime(
      { interrupt } as unknown as EnginePort,
    );

    expect(task.status).toBe("initializing");
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
    task.runner = createInProcessTaskRunnerRuntime(
      { interrupt: vi.fn() } as unknown as EnginePort,
    );
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
    task.runner = createInProcessTaskRunnerRuntime(
      { interrupt } as unknown as EnginePort,
    );
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
  it("모든 active task를 interrupted로 기록한 뒤 interrupt + drain", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const t1 = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    const t2 = await tm.createTask({ agentSessionId: "s2", prompt: "y", profileId: "p" });
    t1.status = "running";
    const int1 = vi.fn().mockResolvedValue(true);
    const int2 = vi.fn().mockResolvedValue(true);
    t1.runner = createInProcessTaskRunnerRuntime(
      { interrupt: int1 } as unknown as EnginePort,
    );
    t2.runner = createInProcessTaskRunnerRuntime(
      { interrupt: int2 } as unknown as EnginePort,
    );
    t1.executionPromise = Promise.resolve();
    t2.executionPromise = Promise.resolve();

    await tm.shutdown();
    expect(t1.status).toBe("interrupted");
    expect(t2.status).toBe("interrupted");
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "session_ended" }),
      expect.objectContaining({
        kind: "terminal_transition",
        status: "interrupted",
        termination_reason: "killed",
        termination_detail: "shutdown",
      }),
    );
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
    expect(int1).toHaveBeenCalledTimes(1);
    expect(int2).toHaveBeenCalledTimes(1);
  });

  it("shutdown 상태 기록 실패가 interrupt를 막지 않음", async () => {
    const mocks = makeMocks();
    mocks.updateSession.mockRejectedValueOnce(new Error("db down"));
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    task.status = "running";
    const interrupt = vi.fn().mockResolvedValue(true);
    task.runner = createInProcessTaskRunnerRuntime(
      { interrupt } as unknown as EnginePort,
    );
    task.executionPromise = Promise.resolve();

    await tm.shutdown();

    expect(task.status).toBe("interrupted");
    expect(interrupt).toHaveBeenCalledTimes(1);
  });
});

describe("TaskManager.addIntervention (B-4)", () => {
  it("running task delivers through the engine intervention operation", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({
      agentSessionId: "s-live",
      prompt: "p",
      profileId: "codex-default",
    });
    task.status = "running";
    const intervene = vi.fn().mockResolvedValue({
      status: "delivered",
      mechanism: "active_turn",
    });
    task.runner = createInProcessTaskRunnerRuntime({
      backendId: "codex",
      workspaceDir: "/tmp/codex",
      async *execute(): AsyncIterable<never> {},
      async interrupt() { return true; },
      async close() {},
      intervene,
    } as unknown as EnginePort);
    vi.spyOn(task.runner.dispatcher, "hasActiveExecution").mockReturnValue(true);

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
    expect(intervene).toHaveBeenCalledWith({
      prompt: "focus on the failing test\n\n[첨부 파일 로컬 경로: /tmp/a.png]",
      imageAttachmentPaths: ["/tmp/a.png"],
      turnOrigin: { kind: "user_message" },
    });
    expect(mocks.enqueueEvent).toHaveBeenCalledWith(
      "s-live",
      expect.objectContaining({ type: "intervention_sent" }),
    );
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("running Claude task records intervention_sent before queueing for its next turn", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({
      agentSessionId: "s-claude-steer",
      prompt: "p",
      profileId: "claude-default",
    });
    task.status = "running";
    const intervene = vi.fn().mockResolvedValue({
      status: "not_delivered",
      mechanism: "interrupt_then_next_turn",
      reason: "next_turn_required",
    });
    task.runner = createInProcessTaskRunnerRuntime({
      backendId: "claude",
      workspaceDir: "/tmp/claude",
      async *execute(): AsyncIterable<never> {},
      async interrupt() { return true; },
      async close() {},
      intervene,
    } as unknown as EnginePort);
    vi.spyOn(task.runner.dispatcher, "hasActiveExecution").mockReturnValue(true);

    const result = await tm.addIntervention(
      {
        agentSessionId: "s-claude-steer",
        text: "stop and change direction",
        user: "alice",
      },
      vi.fn(),
    );

    expect(result).toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "next_turn_required",
    });
    expect(intervene).toHaveBeenCalledTimes(1);
    expect(task.interventionQueue).toEqual([
      { text: "stop and change direction", user: "alice" },
    ]);
    expect(mocks.enqueueEvent).toHaveBeenCalledWith(
      "s-claude-steer",
      expect.objectContaining({ type: "intervention_sent" }),
    );
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("running task records intervention_sent when it accepts the message into the queue", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "running";
    expect(task.status).toBe("running");
    expect(task.interventionQueue).toEqual([]);

    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "hello", user: "alice" },
      onResume,
    );

    expect(result).toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "not_supported",
    });
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.interventionQueue[0]).toMatchObject({ text: "hello", user: "alice" });
    expect(mocks.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "intervention_sent" }),
    );
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("연속 큐잉 시 queuePosition이 1, 2로 증가", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({
      agentSessionId: "s1",
      prompt: "p",
      profileId: "codex-default",
    });
    task.status = "running";
    const onResume = vi.fn();
    const r1 = await tm.addIntervention({ agentSessionId: "s1", text: "a", user: "u" }, onResume);
    const r2 = await tm.addIntervention({ agentSessionId: "s1", text: "b", user: "u" }, onResume);
    expect(r1).toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "not_supported",
    });
    expect(r2).toEqual({
      delivered: false,
      queued: true,
      queuePosition: 2,
      consumeWhen: "next_turn",
      reason: "not_supported",
    });
  });

  it("completed task → user_message + durable running effect + onResume + autoResumed", async () => {
    // 결함 A 정정 (PR #55): completed/error/interrupted → intervention_sent가 아닌
    // user_message로 wire 박힘 (Python `create_task(prompt=text)` 모델 정합).
    // 결함 B 정정: running 전이는 durable effect에서 투영되어 닫힌 host
    // WebSocket 뒤에도 soul-app TypingIndicator 상태가 복구된다.
    const broadcasterMocks = makeMocks();
    const tm = new TaskManager(
      "n",
      broadcasterMocks.db,
      broadcasterMocks.broadcaster,
      silentLogger,
      broadcasterMocks.persistence,
    );
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
    expect(broadcasterMocks.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "resume" }),
    );
    expect(
      broadcasterMocks.acquireExecutionOwnershipAndWaitForApplication,
    ).toHaveBeenCalledTimes(1);
    expect(
      broadcasterMocks.acquireExecutionOwnershipAndWaitForApplication,
    ).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        reviewState: "not_required",
        expectedTerminalEventId: null,
      }),
    );
    expect(broadcasterMocks.enqueueRunningTransition).toHaveBeenCalledTimes(0);
    expect(broadcasterMocks.emitSessionUpdated).not.toHaveBeenCalled();
    expect(broadcasterMocks.updateSession).not.toHaveBeenCalled();
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
      broadcasterMocks.persistence,
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
    expect(broadcasterMocks.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "resume" }),
    );
    expect(
      broadcasterMocks.acquireExecutionOwnershipAndWaitForApplication,
    ).toHaveBeenCalledTimes(1);
    expect(broadcasterMocks.enqueueRunningTransition).toHaveBeenCalledTimes(0);
    expect(broadcasterMocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(broadcasterMocks.emitSessionUpdated).not.toHaveBeenCalled();
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
      broadcasterMocks.persistence,
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
    expect(broadcasterMocks.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "resume" }),
    );
    expect(
      broadcasterMocks.acquireExecutionOwnershipAndWaitForApplication,
    ).toHaveBeenCalledTimes(1);
    expect(broadcasterMocks.enqueueRunningTransition).toHaveBeenCalledTimes(0);
    expect(broadcasterMocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(broadcasterMocks.emitSessionUpdated).not.toHaveBeenCalled();
  });

  it("T-1c: contextBuilder 미주입 시에도 auto-resume 상태 전환은 유지", async () => {
    const broadcasterMocks = makeMocks();
    const tm = new TaskManager(
      "n",
      broadcasterMocks.db,
      broadcasterMocks.broadcaster,
      silentLogger,
      broadcasterMocks.persistence,
      // contextBuilder/agentRegistry는 undefined
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

    expect(broadcasterMocks.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "resume" }),
    );
    expect(
      broadcasterMocks.acquireExecutionOwnershipAndWaitForApplication,
    ).toHaveBeenCalledTimes(1);
    expect(broadcasterMocks.enqueueRunningTransition).toHaveBeenCalledTimes(0);
    expect(broadcasterMocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(broadcasterMocks.emitSessionUpdated).not.toHaveBeenCalled();
    expect(task.prompt).toBe("resume");
  });

  it.each(["error", "interrupted"] as const)("%s task → 같은 auto-resume 경로", async (status) => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "running";
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
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "running";
    task.status = "completed";

    // _finalize 미완료 상태를 시뮬레이션 — executionPromise는 살아있고 engine도 살아있음.
    let resolveFinalize: () => void = () => undefined;
    const finalizePromise = new Promise<void>((r) => { resolveFinalize = r; });
    task.executionPromise = finalizePromise;
    const engineCloseSpy = vi.fn().mockResolvedValue(undefined);
    const previousRunner = createInProcessTaskRunnerRuntime(
      { interrupt: async () => true, close: engineCloseSpy } as unknown as EnginePort,
    );
    task.runner = previousRunner;

    const onResumeCalled: Task[] = [];
    const onResume = (t: Task) => {
      expect(t.runner).toBeUndefined();
      onResumeCalled.push(t);
    };

    // addIntervention을 트리거하지만 await — finalize가 아직 끝나지 않아 await 멈춤.
    const addPromise = tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      onResume,
    );

    // 잠시 후 finalize가 끝났다고 신호 + task.runner 정리(시뮬레이션)
    setTimeout(() => {
      task.runner = undefined;
      resolveFinalize();
    }, 5);

    const result = await addPromise;
    expect(result).toEqual({ autoResumed: true });
    expect(onResumeCalled).toHaveLength(1);
    expect(task.runner).toBeDefined();
    expect(task.runner).not.toBe(previousRunner);
    expect(task.executionOwnership).toMatchObject({
      ownerKind: "in_process",
      ownershipGeneration: 1,
    });
  });

  it("completed task에 stale engine만 남아도 정리 후 auto-resume한다", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({
      agentSessionId: "s1",
      prompt: "p",
      profileId: "codex-default",
    });
    task.status = "completed";
    task.completedAt = new Date();

    const close = vi.fn().mockResolvedValue(undefined);
    const staleRunner = createInProcessTaskRunnerRuntime({
      backendId: "claude",
      workspaceDir: "/tmp/claude-work",
      execute: vi.fn(),
      interrupt: vi.fn(),
      close,
    } as unknown as EnginePort);
    task.runner = staleRunner;
    task.executionPromise = undefined;

    const onResume = vi.fn((resumedTask: Task) => {
      expect(resumedTask.runner).toBeUndefined();
    });

    await expect(
      tm.addIntervention({ agentSessionId: "s1", text: "resume", user: "u" }, onResume),
    ).resolves.toEqual({ autoResumed: true });

    expect(close).toHaveBeenCalledTimes(1);
    expect(task.runner).toBeDefined();
    expect(task.runner).not.toBe(staleRunner);
    expect(task.executionOwnership).toMatchObject({
      ownerKind: "in_process",
      ownershipGeneration: 1,
    });
    expect(onResume).toHaveBeenCalledWith(task);
  });

  it("running intervention is not queued when durable ingress enqueue fails", async () => {
    const mocks = makeMocks();
    mocks.enqueueEvent.mockRejectedValueOnce(new Error("outbox down"));
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "running";
    const onResume = vi.fn();
    await expect(tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      onResume,
    )).rejects.toThrow("outbox down");
    expect(task.interventionQueue).toHaveLength(0);
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
  });
});

// B-5: 세션-폴더 배정 정본 (Board Y.Doc 원자 배치)
describe("TaskManager.createTask — 폴더 배정 + catalog broadcast", () => {
  it("folderId 명시 → 해당 폴더 Y.Doc 배치 + emitSessionCreated(task, folderId)", async () => {
    const { db, broadcaster, upsertSessionBoardItem, getFolderById, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s1",
      prompt: "x",
      profileId: "codex-default",
      folderId: "folder-explicit",
    });
    expect(upsertSessionBoardItem).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "folder-explicit",
      container: { containerKind: "folder", containerId: "folder-explicit" },
      sessionId: "s1",
      sourceTaskItemId: null,
    }));
    expect(getFolderById).not.toHaveBeenCalled();  // 명시 folder가 있으면 default lookup 안 함
    expect(emitSessionCreated.mock.calls[0][1]).toBe("folder-explicit");
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("folderId 미지정 → 기본 폴더 id 'claude' lookup + Y.Doc 배치 + emit", async () => {
    const { db, broadcaster, upsertSessionBoardItem, getFolderById, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s2",
      prompt: "x",
      profileId: "codex-default",
    });
    expect(getFolderById).toHaveBeenCalledWith("claude");
    expect(upsertSessionBoardItem).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "claude",
      container: { containerKind: "folder", containerId: "claude" },
      sessionId: "s2",
      sourceTaskItemId: null,
    }));
    expect(emitSessionCreated.mock.calls[0][1]).toBe("claude");
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("folderId 미지정 + 기본 폴더 없음 → 폴더 배정·broadcast 안 함 (graceful, Python L306-307)", async () => {
    const { db, broadcaster, upsertSessionBoardItem, emitSessionCreated, emitCatalogUpdated, getFolderById } = makeMocks();
    getFolderById.mockResolvedValueOnce(null);
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s3",
      prompt: "x",
      profileId: "codex-default",
    });
    expect(upsertSessionBoardItem).not.toHaveBeenCalled();
    expect(emitSessionCreated.mock.calls[0][1]).toBeNull();
    expect(emitCatalogUpdated).not.toHaveBeenCalled();  // 폴더 배정 안 됐으면 broadcast 안 함 (Python L311 gate)
  });

  it("Y.Doc 원자 배치 throw → 격리, task 생성은 성공 (부가 기능 실패 분리)", async () => {
    const { db, broadcaster, upsertSessionBoardItem, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    upsertSessionBoardItem.mockRejectedValueOnce(new Error("host proxy down"));
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

  it("getAllFolders throw → 격리 (Python L317-321 정합), task·session_created 정상 진행", async () => {
    const { db, broadcaster, getAllFolders, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    getAllFolders.mockRejectedValueOnce(new Error("catalog query down"));
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "s5",
      prompt: "x",
      profileId: "codex-default",
      folderId: "f-y",
    });
    expect(task.agentSessionId).toBe("s5");
    expect(emitSessionCreated.mock.calls[0][1]).toBe("f-y");  // Y.Doc 원자 배치는 성공
    expect(emitCatalogUpdated).not.toHaveBeenCalled();  // catalog 실패는 broadcast 차단
  });

  it("emitCatalogUpdated가 emitSessionCreated *이전*에 호출됨 (Python L304 순서 보장)", async () => {
    const { db, broadcaster, upsertSessionBoardItem, emitSessionCreated, emitCatalogUpdated } = makeMocks();
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
    expect(upsertSessionBoardItem.mock.invocationCallOrder[0]).toBeLessThan(catalogOrder);
    expect(catalogOrder).toBeLessThan(createdOrder);
  });
});

// B-5: session_broadcaster.emitCatalogUpdated wire 형상 회귀는 session_broadcaster.test.ts에서 보호.

// B-5: live surface가 없는 running task는 다음 turn queue fallback이 정본.
describe("TaskManager.addIntervention — running fallback without live surface (B-5)", () => {
  it("persistence 주입 시 live surface가 없어도 접수 이벤트를 기록한 뒤 queue에 보존", async () => {
    const mocks = makeMocks();
    const enqueueEvent = vi.fn().mockResolvedValue(123);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { enqueueEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;

    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "running";
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
    expect(enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "intervention_sent", text: "추가 메시지" }),
    );
    expect(handleSideEffects).toHaveBeenCalledTimes(1);
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(task.lastEventId).toBe(0);
  });

  it("공통 persistence + live surface 없음 → durable 접수 후 queue에 보존", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "running";
    await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      vi.fn(),
    );
    expect(task.interventionQueue).toEqual([{ text: "x", user: "u" }]);
    expect(mocks.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "intervention_sent", text: "x" }),
    );
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("enqueueEvent 실패 시 running intervention을 queue에 넣지 않고 실패를 반환", async () => {
    const mocks = makeMocks();
    const enqueueEvent = vi.fn().mockRejectedValueOnce(new Error("events db down"));
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { enqueueEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "running";
    await expect(
      tm.addIntervention(
        { agentSessionId: "s1", text: "x", user: "u" },
        vi.fn(),
      ),
    ).rejects.toThrow("events db down");
    expect(task.interventionQueue).toEqual([]);
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
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
    const enqueueEvent = vi.fn().mockResolvedValue(1);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { enqueueEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "running";
    expect(task.status).toBe("running");

    await tm.addIntervention(
      { agentSessionId: "s1", text: "추가", user: "u" },
      vi.fn(),
    );

    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(task.interventionQueue).toEqual([{ text: "추가", user: "u" }]);
  });

  it("completed task → durable running effect + user_message 접수 후 onResume", async () => {
    const mocks = makeMocks();
    const enqueueEvent = vi.fn().mockResolvedValue(2);
    const enqueueMetadataEffect = vi.fn().mockResolvedValue(null);
    const enqueueRunningTransition = vi.fn().mockResolvedValue({ source_seq: 2 });
    const enqueueRunningTransitionAndWaitForApplication = vi.fn(
      async (sessionId, input) => {
        await enqueueRunningTransition(sessionId, input);
        return {
          eventId: 2,
          applied: true,
          canonicalSession: {
            status: "running",
            termination_reason: null,
            termination_detail: null,
            review_state: input.reviewState,
            last_assistant_text: null,
            termination_event_id: null,
            updated_at: "2026-08-12T00:00:00.000Z",
            last_event_id: null,
          },
        };
      },
    );
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = {
      enqueueEvent,
      enqueueMetadataEffect,
      enqueueRunningTransition,
      enqueueRunningTransitionAndWaitForApplication,
      handleSideEffects,
    } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "completed";
    task.completedAt = new Date();

    await tm.addIntervention(
      { agentSessionId: "s1", text: "이어서", user: "alice", callerInfo: { source: "slack", display_name: "Alice" } },
      vi.fn(),
    );

    expect(enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "이어서" }),
    );
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(enqueueRunningTransition).toHaveBeenCalledTimes(1);
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();

    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
    expect(task.status).toBe("running");
    expect(task.prompt).toBe("이어서");
    expect(task.clientId).toBe("alice");
    expect(task.callerInfo).toEqual({ source: "slack", display_name: "Alice" });
    expect(task.metadata).toContainEqual({
      type: "caller_info",
      value: { source: "slack", display_name: "Alice" },
    });
    expect(enqueueMetadataEffect).toHaveBeenCalledWith("s1", {
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = status;
    await tm.addIntervention(
      { agentSessionId: "s1", text: "재개", user: "u" },
      vi.fn(),
    );
    expect(mocks.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "재개" }),
    );
    expect(
      mocks.acquireExecutionOwnershipAndWaitForApplication,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueRunningTransition).toHaveBeenCalledTimes(0);
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
  });

  it("auto-resume addIntervention은 durable running effect와 user_message를 발행", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "completed";
    await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      vi.fn(),
    );
    expect(mocks.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "x" }),
    );
    expect(
      mocks.acquireExecutionOwnershipAndWaitForApplication,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueRunningTransition).toHaveBeenCalledTimes(0);
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
  });
});

// PR #56: 결함 D — 서버 재기동 후 task hydration (Python load_evicted_task 정합)
describe("TaskManager.addIntervention — 메모리 비어 있을 때 DB hydration (결함 D)", () => {
  it("메모리에 task가 없고 DB에도 없으면 throw (현 동작 보존)", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce(null);
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);

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
    expect(mocks.enqueueEvent).toHaveBeenCalledWith(
      "sess-evicted",
      expect.objectContaining({ type: "user_message", text: "이어서" }),
    );
    expect(
      mocks.acquireExecutionOwnershipAndWaitForApplication,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueRunningTransition).toHaveBeenCalledTimes(0);
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    expect(mocks.enqueueEvent).toHaveBeenCalledWith(
      "sess-evicted-claude",
      expect.objectContaining({
        type: "user_message",
        text: "resume from last event",
      }),
    );
    expect(
      mocks.acquireExecutionOwnershipAndWaitForApplication,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueRunningTransition).toHaveBeenCalledTimes(0);
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(onResume).toHaveBeenCalledWith(memTask);
  });

  it("queues input for a hydrated running session without spawning a competing execution", async () => {
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const onResume = vi.fn();

    const result = await tm.addIntervention(
      { agentSessionId: "sess-stale-running", text: "resume", user: "u" },
      onResume,
    );

    expect(result).toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "not_supported",
    });
    const memTask = tm.getTask("sess-stale-running");
    expect(memTask).toBeDefined();
    expect(memTask!.status).toBe("running");
    expect(memTask!.codexThreadId).toBe("thr-stale");
    expect(memTask!.interventionQueue).toEqual([
      expect.objectContaining({ text: "resume", user: "u" }),
    ]);
    expect(mocks.enqueueEvent).toHaveBeenCalledWith(
      "sess-stale-running",
      expect.objectContaining({ type: "intervention_sent", text: "resume" }),
    );
    expect(mocks.enqueueRunningTransition).not.toHaveBeenCalled();
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    await expect(
      tm.addIntervention({ agentSessionId: "sess-bad", text: "x", user: "u" }, vi.fn()),
    ).rejects.toThrow("Task not found: sess-bad");
  });

  it("db.getSession throw → hydration failure로 명시적 실패", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockRejectedValueOnce(new Error("db connection lost"));
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    await expect(
      tm.addIntervention({ agentSessionId: "sess-x", text: "x", user: "u" }, vi.fn()),
    ).rejects.toThrow("Task hydration failed: sess-x");
  });

  it("메모리에 task가 있으면 hydration skip (기존 동작 보존)", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
    const task = await tm.createTask({
      agentSessionId: "s1",
      prompt: "p",
      profileId: "codex-default",
    });
    task.status = "running";
    expect(tm.getTask("s1")).toBeDefined();
    mocks.getSession.mockClear();
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, mocks.persistence);
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
