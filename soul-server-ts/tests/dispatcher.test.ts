import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry, type AgentProfile } from "../src/agent_registry.js";
import type { AgentConfigService } from "../src/agent_config_service.js";
import { FileAttachmentStore, type AttachmentStore } from "../src/attachments/file_manager.js";
import { CommandDispatcher } from "../src/upstream/dispatcher.js";
import type {
  ClaudeAuthCommandHandler,
  ClaudeAuthSetTokenCmd,
} from "../src/auth/claude_auth.js";
import type { SessionDB } from "../src/db/session_db.js";
import type { RealtimeBroker } from "../src/realtime/realtime_broker.js";
import type { TaskExecutor } from "../src/task/task_executor.js";
import { TaskManager } from "../src/task/task_manager.js";
import type { Task } from "../src/task/task_models.js";
import type { SessionBroadcaster } from "../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

const codexAgent: AgentProfile = {
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

function createDispatcher(opts: {
  nodeId?: string;
  agents?: AgentProfile[];
  runningTasks?: number;
  taskManager?: Partial<TaskManager>;
  taskExecutor?: Partial<TaskExecutor>;
  attachmentStore?: AttachmentStore;
  claudeAuth?: ClaudeAuthCommandHandler;
  sessionDb?: Partial<SessionDB>;
  realtimeBroker?: Partial<RealtimeBroker>;
  agentConfigService?: Pick<
    AgentConfigService,
    "listSnapshots" | "planProfileUpdate" | "replaceProfile" | "rollback"
  >;
} = {}) {
  const sent: unknown[] = [];
  const send = vi.fn(async (data: unknown) => {
    sent.push(data);
  });
  const registry = new AgentRegistry(opts.agents ?? [codexAgent]);

  const createdTasks: Task[] = [];
  const runningTasks: Task[] = Array(opts.runningTasks ?? 0)
    .fill(null)
    .map((_, i) => ({
      agentSessionId: `running-${i}`,
      prompt: "",
      status: "running" as const,
      createdAt: new Date(),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    }));

  const defaultTaskManager: Partial<TaskManager> = {
    createTask: vi.fn(async (params) => {
      const task: Task = {
        agentSessionId: params.agentSessionId,
        prompt: params.prompt,
        status: "running",
        profileId: params.profileId,
        callerSessionId: params.callerSessionId ?? undefined,
        callerInfo: params.callerInfo,
        notifyCompletion: params.notifyCompletion,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        oauthToken: params.oauthToken,
        allowedTools: params.allowedTools,
        disallowedTools: params.disallowedTools,
        useMcp: params.useMcp,
        claudePermissionMode: params.claudePermissionMode,
        contextItems: params.contextItems,
        attachmentPaths: params.attachmentPaths,
        createdAt: new Date(),
        lastEventId: 0,
        lastReadEventId: 0,
        interventionQueue: [],
      };
      createdTasks.push(task);
      return task;
    }),
    listTasks: vi.fn(() => runningTasks),
    addIntervention: vi.fn(),
    cancelTask: vi.fn(async () => true),
    acknowledgeReview: vi.fn(async () => "acknowledged"),
    deliverInputResponse: vi.fn(),
    deliverToolApproval: vi.fn(),
  };

  const defaultExecutor: Partial<TaskExecutor> = {
    startExecution: vi.fn(),
  };

  const tm = { ...defaultTaskManager, ...opts.taskManager } as TaskManager;
  const te = { ...defaultExecutor, ...opts.taskExecutor } as TaskExecutor;

  // sessionDb 미주입(=undefined)이면 dispatcher에도 그대로 undefined 전달 (Phase B list_sessions 명시 error 분기 테스트용)
  const sessionDb = opts.sessionDb === undefined ? undefined : (opts.sessionDb as SessionDB);

  const dispatcher = new CommandDispatcher(
    send,
    silentLogger,
    opts.nodeId ?? "eias-shopping-ts",
    registry,
    tm,
    te,
    opts.attachmentStore,
    opts.claudeAuth,
    sessionDb,
    opts.realtimeBroker as RealtimeBroker | undefined,
    undefined,
    opts.agentConfigService,
  );
  return { dispatcher, sent, send, registry, tm, te, createdTasks, sessionDb };
}

function createAttachmentStore(overrides: Partial<AttachmentStore> = {}): AttachmentStore {
  return {
    saveFileForSession: vi.fn(async (params) => ({
      path: `/tmp/${params.sessionId}/${params.filename}`,
      filename: params.filename,
      size: params.content.length,
      content_type: params.contentType ?? "application/octet-stream",
    })),
    beginFileUpload: vi.fn(async (params) => ({
      uploadId: params.uploadId,
      next_chunk_index: 0,
    })),
    appendFileUploadChunk: vi.fn(async (params) => ({
      uploadId: params.uploadId,
      chunk_index: params.chunkIndex,
      next_chunk_index: params.chunkIndex + 1,
      size: params.chunk.length,
    })),
    finishFileUpload: vi.fn(async (params) => ({
      path: `/tmp/sess/${params.uploadId}.txt`,
      filename: `${params.uploadId}.txt`,
      size: 5,
      content_type: "text/plain",
    })),
    abortFileUpload: vi.fn(async () => true),
    cleanupSession: vi.fn(async () => 0),
    downloadAttachment: vi.fn(async () => ({
      content_b64: "",
      content_type: "application/octet-stream",
      filename: "empty",
      size: 0,
    })),
    ...overrides,
  };
}

describe("CommandDispatcher.health_check", () => {
  it("registered agent count를 max_concurrent로, running task 개수를 active로 박음", async () => {
    const { dispatcher, sent } = createDispatcher({ runningTasks: 1 });
    await dispatcher.dispatch({ type: "health_check", requestId: "req-1" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "health_status",
      runners: { max_concurrent: 1, active: 1 },
      node_id: "eias-shopping-ts",
      requestId: "req-1",
    });
  });

  it("Claude profile도 registry profile이면 health max_concurrent에 포함", async () => {
    const { dispatcher, sent } = createDispatcher({
      agents: [codexAgent, claudeAgent],
      runningTasks: 1,
    });

    await dispatcher.dispatch({ type: "health_check", requestId: "req-1" });

    expect(sent[0]).toMatchObject({
      runners: { max_concurrent: 2, active: 1 },
    });
  });

  it("requestId 없으면 빈 문자열 fallback", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ type: "health_check" });
    expect((sent[0] as { requestId: string }).requestId).toBe("");
  });

  it("snake_case request_id도 camel로 회신", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ type: "health_check", request_id: "snake-1" });
    expect((sent[0] as { requestId: string }).requestId).toBe("snake-1");
  });
});

describe("CommandDispatcher tool approvals", () => {
  it("reject_tool → deliverToolApproval + tool_approval_ack(status ok)", async () => {
    const deliverToolApproval = vi.fn().mockResolvedValue({
      status: "delivered",
      approvalId: "danger-call-1",
      decision: "rejected",
      eventId: 42,
    });
    const { dispatcher, sent } = createDispatcher({
      taskManager: { deliverToolApproval } as Partial<TaskManager>,
    });

    await dispatcher.dispatch({
      type: "reject_tool",
      agentSessionId: "sess-agents",
      approvalId: "danger-call-1",
      requestId: "orch-approval-1",
      message: "User rejected dangerous DB write",
    });

    expect(deliverToolApproval).toHaveBeenCalledWith(
      {
        agentSessionId: "sess-agents",
        approvalId: "danger-call-1",
        decision: "rejected",
        message: "User rejected dangerous DB write",
      },
      expect.any(Function),
    );
    expect(sent).toEqual([
      {
        type: "tool_approval_ack",
        requestId: "orch-approval-1",
        approvalId: "danger-call-1",
        decision: "rejected",
        status: "ok",
        delivered: true,
        eventId: 42,
      },
    ]);
  });

  it("approve_tool failure도 ACK error로 반환해 orch timeout을 막음", async () => {
    const deliverToolApproval = vi.fn().mockResolvedValue({
      status: "approval_not_pending",
      approvalId: "danger-call-1",
      decision: "approved",
      message: "not pending",
    });
    const { dispatcher, sent } = createDispatcher({
      taskManager: { deliverToolApproval } as Partial<TaskManager>,
    });

    await dispatcher.dispatch({
      type: "approve_tool",
      agentSessionId: "sess-agents",
      approvalId: "danger-call-1",
      requestId: "orch-approval-2",
    });

    expect(sent).toEqual([
      expect.objectContaining({
        type: "tool_approval_ack",
        requestId: "orch-approval-2",
        approvalId: "danger-call-1",
        decision: "approved",
        status: "error",
        code: "TOOL_APPROVAL_NOT_PENDING",
        message: "not pending",
      }),
    ]);
  });
});

describe("CommandDispatcher realtime commands", () => {
  it("realtime_create_call → broker + realtime_call_created(status ok)", async () => {
    const createCall = vi.fn().mockResolvedValue({
      status: "ok",
      agentSessionId: "sess-rt",
      callId: "call_1",
      answerSdp: "answer-sdp",
      eventId: 55,
    });
    const { dispatcher, sent } = createDispatcher({
      realtimeBroker: { createCall },
    });

    await dispatcher.dispatch({
      type: "realtime_create_call",
      agentSessionId: "sess-rt",
      offerSdp: "offer-sdp",
      requestId: "rt-1",
      voice: "alloy",
    });

    expect(createCall).toHaveBeenCalledWith({
      agentSessionId: "sess-rt",
      offerSdp: "offer-sdp",
      voice: "alloy",
    });
    expect(sent).toEqual([
      {
        type: "realtime_call_created",
        requestId: "rt-1",
        agentSessionId: "sess-rt",
        status: "ok",
        callId: "call_1",
        answerSdp: "answer-sdp",
        eventId: 55,
      },
    ]);
  });

  it("realtime_resolve_tool_approval failure도 ACK error로 반환", async () => {
    const resolveToolApproval = vi.fn().mockRejectedValue(new Error("no call"));
    const { dispatcher, sent } = createDispatcher({
      realtimeBroker: { resolveToolApproval },
    });

    await dispatcher.dispatch({
      type: "realtime_resolve_tool_approval",
      agentSessionId: "sess-rt",
      approvalId: "approval-1",
      decision: "approved",
      requestId: "rt-approve-1",
    });

    expect(sent).toEqual([
      expect.objectContaining({
        type: "realtime_tool_approval_ack",
        requestId: "rt-approve-1",
        agentSessionId: "sess-rt",
        status: "error",
        code: "REALTIME_ERROR",
        message: "no call",
      }),
    ]);
  });
});

describe("CommandDispatcher.create_session", () => {
  it("정상 흐름: task_manager.createTask + task_executor.startExecution + session_created ACK", async () => {
    const { dispatcher, sent, tm, te, createdTasks } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-1",
      prompt: "hi",
      profile: "codex-default",
      requestId: "cs-1",
    });

    expect(tm.createTask).toHaveBeenCalledTimes(1);
    expect(te.startExecution).toHaveBeenCalledTimes(1);
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].agentSessionId).toBe("sess-1");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "session_created",
      agentSessionId: "sess-1",
      requestId: "cs-1",
    });
  });

  it("requestId 없으면 session_created ACK 발행 안 함 (atom c13f7826)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-1",
      prompt: "hi",
      profile: "codex-default",
    });
    expect(sent).toHaveLength(0);
  });

  it("extra_context_items를 createTask.contextItems로 전달", async () => {
    const { dispatcher, createdTasks } = createDispatcher();
    const contextItems = [
      { key: "attached_files", label: "첨부 파일", content: "- /tmp/a.png" },
    ];
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-ctx",
      prompt: "see file",
      profile: "codex-default",
      extra_context_items: contextItems,
    });
    expect(createdTasks[0].contextItems).toEqual(contextItems);
  });

  it("reasoningEffort를 createTask로 전달", async () => {
    const { dispatcher, createdTasks } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-reasoning",
      prompt: "think",
      profile: "codex-default",
      reasoningEffort: "medium",
    });
    expect(createdTasks[0].reasoningEffort).toBe("medium");
  });

  it("create_session 도구/MCP 옵션을 createTask로 전달", async () => {
    const { dispatcher, createdTasks } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-tools",
      prompt: "tool gated",
      profile: "codex-default",
      allowed_tools: ["Read"],
      disallowed_tools: ["Bash"],
      use_mcp: false,
      claude_permission_mode: "default",
    });
    expect(createdTasks[0].allowedTools).toEqual(["Read"]);
    expect(createdTasks[0].disallowedTools).toEqual(["Bash"]);
    expect(createdTasks[0].useMcp).toBe(false);
    expect(createdTasks[0].claudePermissionMode).toBe("default");
  });

  it("notify_completion=false를 createTask로 전달", async () => {
    const { dispatcher, createdTasks } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-fire-forget",
      prompt: "fire and forget",
      profile: "codex-default",
      notify_completion: false,
    });
    expect(createdTasks[0].notifyCompletion).toBe(false);
  });

  it("create_session 과도기 camelCase 도구/MCP 옵션도 createTask로 전달", async () => {
    const { dispatcher, createdTasks } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-tools-camel",
      prompt: "tool gated",
      profile: "codex-default",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      useMcp: false,
      claudePermissionMode: "acceptEdits",
    });
    expect(createdTasks[0].allowedTools).toEqual(["Read"]);
    expect(createdTasks[0].disallowedTools).toEqual(["Bash"]);
    expect(createdTasks[0].useMcp).toBe(false);
    expect(createdTasks[0].claudePermissionMode).toBe("acceptEdits");
  });

  it("oauth_token을 createTask.oauthToken으로 전달한다", async () => {
    const { dispatcher, createdTasks } = createDispatcher({
      agents: [codexAgent, claudeAgent],
    });
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-oauth",
      prompt: "use claude token",
      profile: "claude-roselin",
      oauth_token: "task-oauth-token",
    });
    expect(createdTasks[0].oauthToken).toBe("task-oauth-token");
  });

  it("attachment_paths가 오면 prompt 본문에 path note를 추가하고 전체 경로는 task에 보존", async () => {
    const { dispatcher, createdTasks } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-attach",
      prompt: "see file",
      profile: "codex-default",
      attachment_paths: ["/tmp/a.png", "/tmp/b.txt"],
    });
    expect(createdTasks[0].prompt).toBe(
      "see file\n\n" +
        "[첨부 파일 로컬 경로: /tmp/a.png]\n" +
        "[첨부 파일 로컬 경로: /tmp/b.txt]",
    );
    expect(createdTasks[0].contextItems).toBeUndefined();
    expect(createdTasks[0].attachmentPaths).toEqual(["/tmp/a.png", "/tmp/b.txt"]);
  });

  it("agentSessionId 또는 prompt 부재 시 error", async () => {
    const { dispatcher, sent, tm } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      prompt: "hi",
      profile: "codex-default",
      requestId: "r1",
    });
    expect(sent[0]).toMatchObject({ type: "error", command_type: "create_session" });
    expect(tm.createTask).not.toHaveBeenCalled();
  });

  it("profile 부재 시 error", async () => {
    const { dispatcher, sent, tm } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-1",
      prompt: "hi",
      requestId: "r1",
    });
    expect((sent[0] as { message: string }).message).toContain("profile");
    expect(tm.createTask).not.toHaveBeenCalled();
  });

  it("Unknown agent profile → error", async () => {
    const { dispatcher, sent, tm } = createDispatcher();
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-1",
      prompt: "hi",
      profile: "nonexistent",
      requestId: "r1",
    });
    expect((sent[0] as { message: string }).message).toContain("Unknown agent profile");
    expect(tm.createTask).not.toHaveBeenCalled();
  });

  it("Claude backend profile도 agent boundary를 보존해 executor에 전달", async () => {
    const { dispatcher, sent, tm, te, createdTasks } = createDispatcher({
      agents: [codexAgent, claudeAgent],
    });

    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-claude",
      prompt: "hi",
      profile: "claude-roselin",
      requestId: "r1",
    });

    expect(tm.createTask).toHaveBeenCalledTimes(1);
    expect(te.startExecution).toHaveBeenCalledWith(createdTasks[0], claudeAgent);
    expect(sent[0]).toEqual({
      type: "session_created",
      agentSessionId: "sess-claude",
      requestId: "r1",
    });
  });

  it("createTask가 throw하면 error 응답 (Handler error wrap)", async () => {
    const { dispatcher, sent } = createDispatcher({
      taskManager: {
        createTask: vi.fn().mockRejectedValue(new Error("db down")),
      },
    });
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-1",
      prompt: "hi",
      profile: "codex-default",
      requestId: "r1",
    });
    expect((sent[0] as { type: string }).type).toBe("error");
    expect((sent[0] as { message: string }).message).toContain("db down");
  });
});

describe("CommandDispatcher.intervene (B-4)", () => {
  it("running task에 intervene → addIntervention queued → intervene_ack(queued)", async () => {
    const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
    const { dispatcher, sent } = createDispatcher({
      taskManager: { addIntervention } as Partial<TaskManager>,
    });
    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-live",
      text: "steer now",
      user: "alice",
      extra_context_items: [
        { key: "supervisor", label: "Supervisor", content: "fresh context" },
      ],
      requestId: "i-live",
    });

    expect(addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-live",
        text: "steer now",
        user: "alice",
        context: [
          { key: "supervisor", label: "Supervisor", content: "fresh context" },
        ],
      }),
      expect.any(Function),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "intervene_ack",
      requestId: "i-live",
      status: "ok",
      outcome: "queued",
      queuePosition: 1,
    });
  });

  it("running task에 intervene → addIntervention queued → intervene_ack(queued, queuePosition)", async () => {
    const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 2 }));
    const { dispatcher, sent } = createDispatcher({
      taskManager: { addIntervention } as Partial<TaskManager>,
    });
    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-1",
      text: "hello",
      user: "alice",
      requestId: "i1",
    });
    expect(addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-1",
        text: "hello",
        user: "alice",
      }),
      expect.any(Function),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "intervene_ack",
      requestId: "i1",
      status: "ok",
      outcome: "queued",
      queuePosition: 2,
    });
  });

  it("completed task에 intervene → auto-resume → intervene_ack(auto_resumed) + startExecution 호출", async () => {
    // addIntervention이 onResume 콜백 호출을 흉내내어 dispatcher의 startExecution 분기 검증.
    const startExecution = vi.fn();
    const fakeAgent: AgentProfile = {
      id: "codex-default",
      name: "Codex Default",
      backend: "codex",
      workspace_dir: "/tmp/codex-default",
    };
    const fakeTask: Task = {
      agentSessionId: "sess-2",
      prompt: "prior",
      status: "running",
      profileId: fakeAgent.id,
      createdAt: new Date(),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    };
    const addIntervention = vi.fn(async (_params, onResume) => {
      onResume(fakeTask);
      return { autoResumed: true };
    });
    const { dispatcher, sent } = createDispatcher({
      agents: [fakeAgent],
      taskManager: { addIntervention } as Partial<TaskManager>,
      taskExecutor: { startExecution } as Partial<TaskExecutor>,
    });
    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-2",
      text: "resume me",
      requestId: "i2",
    });
    expect(startExecution).toHaveBeenCalledWith(fakeTask, fakeAgent);
    expect(sent[0]).toMatchObject({
      type: "intervene_ack",
      requestId: "i2",
      status: "ok",
      outcome: "auto_resumed",
      agentSessionId: "sess-2",
    });
  });

  it("completed+evicted Claude 세션 intervene는 dispatcher 경유로 hydrate 후 기존 Claude session id로 재개", async () => {
    const sessionId = "c23ddf98-3c2d-4e22-baa7-aa1e6d226b03";
    const claudeSessionId = "736ddf46-4c72-4b02-a44a-fab3e5e58fe5";
    const prodClaudeAgent: AgentProfile = {
      id: "seosoyoung",
      name: "서소영",
      backend: "claude",
      workspace_dir: "/home/eias/seosoyoung-workspace/seosoyoung",
    };
    const registry = new AgentRegistry([prodClaudeAgent]);
    const sent: unknown[] = [];
    const send = vi.fn(async (data: unknown) => {
      sent.push(data);
    });
    const getSession = vi.fn(async (id: string) =>
      id === sessionId
        ? {
            session_id: sessionId,
            folder_id: "8dff6b9c-60a8-4c66-961c-b5c347fa9c0a",
            display_name: "완료된 claude 세션",
            node_id: "eiaserinnys",
            session_type: "claude",
            status: "completed",
            prompt: "previous turn",
            client_id: null,
            claude_session_id: claudeSessionId,
            last_message: null,
            metadata: [],
            was_running_at_shutdown: false,
            last_event_id: 581,
            last_read_event_id: 581,
            created_at: new Date("2026-06-07T14:00:00.000Z"),
            updated_at: new Date("2026-06-07T16:15:32.000Z"),
            agent_id: prodClaudeAgent.id,
            caller_session_id: null,
            away_summary: null,
            termination_reason: "completed_ok",
            termination_detail: null,
          }
        : null,
    );
    const updateSession = vi.fn(async () => undefined);
    const db = {
      getSession,
      updateSession,
      appendMetadata: vi.fn(async () => undefined),
      listSupervisorRegistries: vi.fn(async () => [
        { role: "ariella-ashwood-codex", activeSessionId: "supervisor-1", epoch: 1 },
      ]),
    } as unknown as SessionDB;
    const broadcaster = {
      emitSessionUpdated: vi.fn(async () => undefined),
    } as unknown as SessionBroadcaster;
    const taskManager = new TaskManager(
      "eiaserinnys",
      db,
      broadcaster,
      silentLogger,
      undefined,
      undefined,
      registry,
    );
    const startExecution = vi.fn();
    const dispatcher = new CommandDispatcher(
      send,
      silentLogger,
      "eiaserinnys",
      registry,
      taskManager,
      { startExecution } as unknown as TaskExecutor,
      undefined,
      undefined,
      db,
    );

    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: sessionId,
      text: "이어가",
      user: "browser",
      requestId: "resume-c23",
    });

    expect(sent).toEqual([
      {
        type: "intervene_ack",
        requestId: "resume-c23",
        status: "ok",
        outcome: "auto_resumed",
        agentSessionId: sessionId,
      },
    ]);
    expect(getSession).toHaveBeenCalledWith(sessionId);
    expect(updateSession).toHaveBeenCalledWith(sessionId, {
      status: "running",
      last_event_id: 581,
      termination_reason: null,
      termination_detail: null,
      review_state: "not_required",
    });
    expect(startExecution).toHaveBeenCalledTimes(1);
    const [resumedTask, agent] = startExecution.mock.calls[0] as [Task, AgentProfile];
    expect(agent).toBe(prodClaudeAgent);
    expect(resumedTask).toMatchObject({
      agentSessionId: sessionId,
      status: "running",
      hydratedFromDb: true,
      profileId: prodClaudeAgent.id,
      sessionType: "claude",
      codexThreadId: claudeSessionId,
      lastEventId: 581,
      lastReadEventId: 581,
      terminationReason: undefined,
      terminationDetail: undefined,
    });
    expect(resumedTask.interventionQueue).toEqual([
      expect.objectContaining({
        text: "이어가",
        user: "browser",
      }),
    ]);
  });

  it("미존재 task에 intervene → addIntervention throw → error wire", async () => {
    const addIntervention = vi.fn(async () => {
      throw new Error("Task not found: sess-missing");
    });
    const { dispatcher, sent } = createDispatcher({
      taskManager: { addIntervention } as Partial<TaskManager>,
    });
    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-missing",
      text: "x",
      requestId: "i3",
    });
    expect((sent[0] as { type: string }).type).toBe("error");
    expect((sent[0] as { message: string }).message).toContain("Task not found");
  });

  it("text 누락 시 sendError (addIntervention 호출 안 함)", async () => {
    const addIntervention = vi.fn();
    const { dispatcher, sent } = createDispatcher({
      taskManager: { addIntervention } as Partial<TaskManager>,
    });
    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-1",
      requestId: "i4",
    });
    expect(addIntervention).not.toHaveBeenCalled();
    expect((sent[0] as { type: string }).type).toBe("error");
    expect((sent[0] as { message: string }).message).toContain("agentSessionId and text");
  });

  it("requestId 부재 시 ACK 발행 안 함 (atom c13f7826 빈 ACK 금지)", async () => {
    const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
    const { dispatcher, sent } = createDispatcher({
      taskManager: { addIntervention } as Partial<TaskManager>,
    });
    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-1",
      text: "x",
    });
    expect(addIntervention).toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("stale supervisor session direct-target intervene를 거부한다", async () => {
    const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
    const { dispatcher, sent } = createDispatcher({
      taskManager: { addIntervention } as Partial<TaskManager>,
      sessionDb: {
        listSupervisorRegistries: vi.fn(async () => [
          {
            role: "ariela_codex",
            activeSessionId: "sess-active",
            epoch: 3,
          },
        ]),
        getSession: vi.fn(async () => ({
          session_id: "sess-stale",
          agent_id: "ariela_codex",
        })),
      } as Partial<SessionDB>,
    });

    await dispatcher.dispatch({
      type: "intervene",
      agentSessionId: "sess-stale",
      text: "direct stale",
      requestId: "stale-1",
    });

    expect(addIntervention).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "stale-1",
      command_type: "intervene",
    });
    expect((sent[0] as { message: string }).message).toContain(
      "Stale supervisor session direct target rejected",
    );
  });

  it("supervisor_intervene는 role epoch를 active session으로 해석해 기존 intervention 경로를 사용한다", async () => {
    const addIntervention = vi.fn(async () => ({ queued: true, queuePosition: 1 }));
    const { dispatcher, sent } = createDispatcher({
      taskManager: { addIntervention } as Partial<TaskManager>,
      sessionDb: {
        listSupervisorRegistries: vi.fn(async () => []),
        getSession: vi.fn(async () => null),
        getSupervisorRegistry: vi.fn(async () => ({
          role: "ariela_codex",
          activeSessionId: "sess-active",
          epoch: 7,
        })),
      } as Partial<SessionDB>,
    });

    await dispatcher.dispatch({
      type: "supervisor_intervene",
      role: "ariela_codex",
      expected_epoch: 7,
      text: "drain cursor head",
      requestId: "sup-1",
    });

    expect(addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-active",
        text: "drain cursor head",
        user: "supervisor",
      }),
      expect.any(Function),
    );
    expect(sent[0]).toMatchObject({
      type: "intervene_ack",
      requestId: "sup-1",
      outcome: "queued",
    });
  });
});

describe("CommandDispatcher.interrupt_session", () => {
  it("interrupt_session → cancelTask + interrupt_session_ack", async () => {
    const cancelTask = vi.fn(async () => true);
    const { dispatcher, sent } = createDispatcher({
      taskManager: { cancelTask } as Partial<TaskManager>,
    });

    await dispatcher.dispatch({
      type: "interrupt_session",
      agentSessionId: "sess-stop",
      requestId: "stop-1",
    });

    expect(cancelTask).toHaveBeenCalledWith("sess-stop");
    expect(sent[0]).toMatchObject({
      type: "interrupt_session_ack",
      requestId: "stop-1",
      status: "ok",
      interrupted: true,
      agentSessionId: "sess-stop",
    });
  });

  it("agentSessionId 누락 시 error wire", async () => {
    const cancelTask = vi.fn();
    const { dispatcher, sent } = createDispatcher({
      taskManager: { cancelTask } as Partial<TaskManager>,
    });

    await dispatcher.dispatch({
      type: "interrupt_session",
      requestId: "stop-2",
    });

    expect(cancelTask).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "stop-2",
    });
    expect((sent[0] as { message: string }).message).toContain("agentSessionId");
  });
});

describe("CommandDispatcher.acknowledge_session_review", () => {
  it("returns an explicit ACK for the atomic review transition", async () => {
    const acknowledgeReview = vi.fn(async () => "acknowledged" as const);
    const { dispatcher, sent } = createDispatcher({
      taskManager: { acknowledgeReview } as Partial<TaskManager>,
    });

    await dispatcher.dispatch({
      type: "acknowledge_session_review",
      agentSessionId: "sess-review",
      requestId: "review-1",
    });

    expect(acknowledgeReview).toHaveBeenCalledWith("sess-review");
    expect(sent).toEqual([{
      type: "acknowledge_session_review_ack",
      requestId: "review-1",
      agentSessionId: "sess-review",
      status: "ok",
      reviewState: "acknowledged",
      changed: true,
      code: undefined,
      message: undefined,
    }]);
  });

  it("returns explicit domain errors instead of timing out", async () => {
    const { dispatcher, sent } = createDispatcher({
      taskManager: {
        acknowledgeReview: vi.fn(async () => "not_required" as const),
      } as Partial<TaskManager>,
    });

    await dispatcher.dispatch({
      type: "acknowledge_session_review",
      agentSessionId: "sess-review",
      requestId: "review-2",
    });

    expect(sent[0]).toMatchObject({
      type: "acknowledge_session_review_ack",
      status: "error",
      code: "REVIEW_NOT_REQUIRED",
    });
  });
});

describe("CommandDispatcher.respond (P4 AskUserQuestion)", () => {
  it("respond → deliverInputResponse + respond_ack(status ok), command requestId와 inputRequestId를 분리", async () => {
    const deliverInputResponse = vi.fn().mockResolvedValue({
      status: "delivered",
      requestId: "ask-hex-1",
      eventId: 42,
    });
    const { dispatcher, sent } = createDispatcher({
      taskManager: { deliverInputResponse } as Partial<TaskManager>,
    });

    await dispatcher.dispatch({
      type: "respond",
      agentSessionId: "sess-ask",
      inputRequestId: "ask-hex-1",
      requestId: "orch-cmd-1",
      answers: { choice: "yes" },
    });

    expect(deliverInputResponse).toHaveBeenCalledWith({
      agentSessionId: "sess-ask",
      requestId: "ask-hex-1",
      answers: { choice: "yes" },
    });
    expect(sent).toEqual([
      {
        type: "respond_ack",
        requestId: "orch-cmd-1",
        inputRequestId: "ask-hex-1",
        status: "ok",
        delivered: true,
        eventId: 42,
      },
    ]);
  });

  it.each([
    ["expired", "INPUT_REQUEST_EXPIRED"],
    ["already_responded", "INPUT_REQUEST_ALREADY_RESPONDED"],
    ["request_not_pending", "REQUEST_NOT_PENDING"],
    ["session_not_running", "SESSION_NOT_RUNNING"],
    ["session_not_found", "SESSION_NOT_FOUND"],
    ["not_supported", "INPUT_RESPONSE_NOT_SUPPORTED"],
  ] as const)("respond failure %s → respond_ack(status error)로 orch timeout을 막음", async (status, code) => {
    const deliverInputResponse = vi.fn().mockResolvedValue({
      status,
      requestId: "ask-hex-1",
      message: "blocked",
      backend: status === "not_supported" ? "codex" : undefined,
    });
    const { dispatcher, sent } = createDispatcher({
      taskManager: { deliverInputResponse } as Partial<TaskManager>,
    });

    await dispatcher.dispatch({
      type: "respond",
      agentSessionId: "sess-ask",
      inputRequestId: "ask-hex-1",
      requestId: "orch-cmd-1",
      answers: { choice: "yes" },
    });

    expect(sent).toEqual([
      expect.objectContaining({
        type: "respond_ack",
        requestId: "orch-cmd-1",
        inputRequestId: "ask-hex-1",
        status: "error",
        code,
        message: "blocked",
      }),
    ]);
  });

  it("snake_case request_id fallback은 input request id로만 사용하고 ACK는 WS requestId로 반환", async () => {
    const deliverInputResponse = vi.fn().mockResolvedValue({
      status: "delivered",
      requestId: "snake-ask",
    });
    const { dispatcher, sent } = createDispatcher({
      taskManager: { deliverInputResponse } as Partial<TaskManager>,
    });

    await dispatcher.dispatch({
      type: "respond",
      agentSessionId: "sess-ask",
      request_id: "snake-ask",
      requestId: "orch-cmd-2",
      answers: {},
    });

    expect(deliverInputResponse).toHaveBeenCalledWith({
      agentSessionId: "sess-ask",
      requestId: "snake-ask",
      answers: {},
    });
    expect(sent[0]).toMatchObject({
      type: "respond_ack",
      requestId: "orch-cmd-2",
      inputRequestId: "snake-ask",
      status: "ok",
    });
  });

  it("inputRequestId 누락 시 deliverInputResponse 호출 없이 error", async () => {
    const deliverInputResponse = vi.fn();
    const { dispatcher, sent } = createDispatcher({
      taskManager: { deliverInputResponse } as Partial<TaskManager>,
    });

    await dispatcher.dispatch({
      type: "respond",
      agentSessionId: "sess-ask",
      requestId: "orch-cmd-3",
      answers: {},
    });

    expect(deliverInputResponse).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "orch-cmd-3",
      command_type: "respond",
    });
  });
});

describe("CommandDispatcher Claude auth/profile commands (P6)", () => {
  function makeClaudeAuthMock(
    overrides: Partial<ClaudeAuthCommandHandler> = {},
  ): ClaudeAuthCommandHandler {
    return {
      status: vi.fn((_requestId, responseType) => ({
        type: responseType,
        requestId: _requestId,
        has_token: true,
      })),
      setToken: vi.fn((_cmd: ClaudeAuthSetTokenCmd, requestId, responseType) => ({
        response: {
          type: responseType,
          requestId,
          success: true,
        },
      })),
      deleteToken: vi.fn((requestId, responseType) => ({
        type: responseType,
        requestId,
        success: true,
      })),
      fetchUsage: vi.fn(async (requestId, responseType) => ({
        type: responseType,
        requestId,
        success: true,
        data: { five_hour: null },
      })),
      fetchProfile: vi.fn(async (requestId, responseType) => ({
        type: responseType,
        requestId,
        success: true,
        data: { account: { email: "agent@example.com" } },
      })),
      ...overrides,
    };
  }

  it("claude_auth_status → Python command type 그대로 has_token ACK", async () => {
    const claudeAuth = makeClaudeAuthMock();
    const { dispatcher, sent } = createDispatcher({
      agents: [claudeAgent],
      claudeAuth,
    });

    await dispatcher.dispatch({ type: "claude_auth_status", requestId: "auth-1" });

    expect(claudeAuth.status).toHaveBeenCalledWith("auth-1", "claude_auth_status");
    expect(sent).toEqual([
      {
        type: "claude_auth_status",
        requestId: "auth-1",
        has_token: true,
      },
    ]);
  });

  it("claude_auth_set_token 성공 → token secret 없이 success ACK", async () => {
    const claudeAuth = makeClaudeAuthMock();
    const { dispatcher, sent } = createDispatcher({
      agents: [claudeAgent],
      claudeAuth,
    });

    await dispatcher.dispatch({
      type: "claude_auth_set_token",
      requestId: "auth-2",
      token: "sk-ant-oat01-valid_token",
      refresh_token: "refresh-secret",
      expires_in: 3600,
      scope: "user:profile",
    });

    expect(claudeAuth.setToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "sk-ant-oat01-valid_token",
        refresh_token: "refresh-secret",
      }),
      "auth-2",
      "claude_auth_set_token",
    );
    expect(sent[0]).toEqual({
      type: "claude_auth_set_token",
      requestId: "auth-2",
      success: true,
    });
    expect(JSON.stringify(sent[0])).not.toContain("sk-ant-oat01");
    expect(JSON.stringify(sent[0])).not.toContain("refresh-secret");
  });

  it("claude_auth_set_token validation 실패 → Python처럼 error wire", async () => {
    const claudeAuth = makeClaudeAuthMock({
      setToken: vi.fn(() => ({ error: "invalid token format" })),
    });
    const { dispatcher, sent } = createDispatcher({
      agents: [claudeAgent],
      claudeAuth,
    });

    await dispatcher.dispatch({
      type: "claude_auth_set_token",
      requestId: "auth-3",
      token: "bad-token",
    });

    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "auth-3",
      command_type: "claude_auth_set_token",
      message: "invalid token format",
    });
  });

  it("claude_auth_delete_token → idempotent ACK", async () => {
    const claudeAuth = makeClaudeAuthMock();
    const { dispatcher, sent } = createDispatcher({
      agents: [claudeAgent],
      claudeAuth,
    });

    await dispatcher.dispatch({ type: "claude_auth_delete_token", requestId: "auth-4" });

    expect(claudeAuth.deleteToken).toHaveBeenCalledWith(
      "auth-4",
      "claude_auth_delete_token",
    );
    expect(sent[0]).toMatchObject({
      type: "claude_auth_delete_token",
      requestId: "auth-4",
      success: true,
    });
  });

  it("usage/profile → mock HTTP service 결과를 같은 command type으로 반환", async () => {
    const claudeAuth = makeClaudeAuthMock();
    const { dispatcher, sent } = createDispatcher({
      agents: [claudeAgent],
      claudeAuth,
    });

    await dispatcher.dispatch({ type: "claude_auth_get_usage", requestId: "auth-5" });
    await dispatcher.dispatch({ type: "claude_auth_get_profile", requestId: "auth-6" });

    expect(claudeAuth.fetchUsage).toHaveBeenCalledWith(
      "auth-5",
      "claude_auth_get_usage",
    );
    expect(claudeAuth.fetchProfile).toHaveBeenCalledWith(
      "auth-6",
      "claude_auth_get_profile",
    );
    expect(sent).toEqual([
      {
        type: "claude_auth_get_usage",
        requestId: "auth-5",
        success: true,
        data: { five_hour: null },
      },
      {
        type: "claude_auth_get_profile",
        requestId: "auth-6",
        success: true,
        data: { account: { email: "agent@example.com" } },
      },
    ]);
  });

  it("Codex-only node로 들어온 Claude auth command는 명시 error", async () => {
    const claudeAuth = makeClaudeAuthMock();
    const { dispatcher, sent } = createDispatcher({ claudeAuth });

    await dispatcher.dispatch({ type: "claude_auth_status", requestId: "auth-codex" });

    expect(claudeAuth.status).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "auth-codex",
      command_type: "claude_auth_status",
    });
    expect((sent[0] as { message: string }).message).toContain("Claude backend");
  });

  it("Claude backend node인데 auth service가 없으면 설정 오류를 반환", async () => {
    const { dispatcher, sent } = createDispatcher({ agents: [claudeAgent] });

    await dispatcher.dispatch({ type: "claude_auth_status", requestId: "auth-missing" });

    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "auth-missing",
      command_type: "claude_auth_status",
    });
    expect((sent[0] as { message: string }).message).toContain("not configured");
  });
});

describe("CommandDispatcher.subscribe_events (SSE realtime sync fix)", () => {
  // 사용자 보고: codex 세션의 진행 중 text_delta가 채팅 영역에 즉시 표시되지 않음. REST history는
  // 정상. 분석 캐시 `20260518-1218-codex-sse-realtime-sync.md` 가설 X — subscribe_events 미구현이
  // 간접 차단. dispatcher가 "Not implemented" error 응답을 wire에 보낸 흔적이 라이브 로그에서 6회 확인.
  // Python `_handle_subscribe_events` 정합: relay loop 시작이지만 TS는 broadcaster.emitEventEnvelope이
  // 이미 모든 task event를 emit하므로 NOOP 수락.

  it("subscribe_events → ACK 없이 silent 수락 (error 응답 미발행)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({
      type: "subscribe_events",
      agentSessionId: "sess-x",
      subscribeId: "sub-1",
    });
    expect(sent).toHaveLength(0);
  });

  it("subscribe_events에 requestId 있어도 ACK 안 발행 (Python 정본 정합)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({
      type: "subscribe_events",
      agentSessionId: "sess-x",
      subscribeId: "sub-1",
      requestId: "req-1",
    });
    // Python `_handle_subscribe_events`도 ACK type emit 안 함 — relay loop만 시작.
    // orch send_subscribe_events는 fire-and-forget이라 ACK 없어도 동작 영향 0.
    expect(sent).toHaveLength(0);
  });

  it("subscribe_events 이후 다른 cmd 흐름에 영향 없음 (handler chain 독립)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ type: "subscribe_events", agentSessionId: "sess-x" });
    await dispatcher.dispatch({ type: "health_check", requestId: "h-1" });
    expect(sent).toHaveLength(1);
    const reply = sent[0] as { type: string };
    expect(reply.type).toBe("health_status");
  });
});

describe("CommandDispatcher attachment reverse-proxy", () => {
  it("upload_attachment → 파일 저장 + upload_attachment_result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "soul-ts-attachments-"));
    try {
      const { dispatcher, sent } = createDispatcher({
        attachmentStore: new FileAttachmentStore(dir),
      });
      await dispatcher.dispatch({
        type: "upload_attachment",
        requestId: "up-1",
        session_id: "sess-1",
        filename: "hello.txt",
        content_type: "text/plain",
        content_b64: Buffer.from("hello").toString("base64"),
      });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: "upload_attachment_result",
        requestId: "up-1",
        filename: expect.stringMatching(/hello\.txt$/),
        size: 5,
        content_type: "text/plain",
      });
      expect((sent[0] as { path: string }).path).toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("upload_attachment requestId 없으면 파일 저장 후 ACK 미발행", async () => {
    const store = createAttachmentStore();
    const { dispatcher, sent } = createDispatcher({ attachmentStore: store });

    await dispatcher.dispatch({
      type: "upload_attachment",
      session_id: "sess-no-ack",
      filename: "hello.txt",
      content_b64: Buffer.from("hello").toString("base64"),
    });

    expect(store.saveFileForSession).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  it("chunked upload start/chunk/finish → temp upload flow ACKs", async () => {
    const store = createAttachmentStore();
    const { dispatcher, sent } = createDispatcher({ attachmentStore: store });

    await dispatcher.dispatch({
      type: "upload_attachment_start",
      requestId: "start-1",
      upload_id: "up-1",
      session_id: "sess-1",
      filename: "hello.txt",
      content_type: "text/plain",
      expected_size: 5,
    });
    await dispatcher.dispatch({
      type: "upload_attachment_chunk",
      requestId: "chunk-1",
      upload_id: "up-1",
      chunk_index: 0,
      content_b64: Buffer.from("hello").toString("base64"),
    });
    await dispatcher.dispatch({
      type: "upload_attachment_finish",
      requestId: "finish-1",
      upload_id: "up-1",
    });

    expect(store.beginFileUpload).toHaveBeenCalledWith({
      uploadId: "up-1",
      sessionId: "sess-1",
      filename: "hello.txt",
      contentType: "text/plain",
      expectedSize: 5,
    });
    expect(store.appendFileUploadChunk).toHaveBeenCalledWith({
      uploadId: "up-1",
      chunkIndex: 0,
      chunk: Buffer.from("hello"),
    });
    expect(store.finishFileUpload).toHaveBeenCalledWith({ uploadId: "up-1" });
    expect(sent).toEqual([
      {
        type: "upload_attachment_start_ack",
        requestId: "start-1",
        upload_id: "up-1",
        next_chunk_index: 0,
      },
      {
        type: "upload_attachment_chunk_ack",
        requestId: "chunk-1",
        upload_id: "up-1",
        chunk_index: 0,
        next_chunk_index: 1,
        size: 5,
      },
      {
        type: "upload_attachment_result",
        requestId: "finish-1",
        path: "/tmp/sess/up-1.txt",
        filename: "up-1.txt",
        size: 5,
        content_type: "text/plain",
      },
    ]);
  });

  it("chunked upload abort → temp cleanup ACK", async () => {
    const store = createAttachmentStore();
    const { dispatcher, sent } = createDispatcher({ attachmentStore: store });

    await dispatcher.dispatch({
      type: "upload_attachment_abort",
      requestId: "abort-1",
      upload_id: "up-1",
    });

    expect(store.abortFileUpload).toHaveBeenCalledWith({ uploadId: "up-1" });
    expect(sent[0]).toEqual({
      type: "upload_attachment_abort_ack",
      requestId: "abort-1",
      upload_id: "up-1",
      aborted: true,
    });
  });

  it("upload_attachment invalid base64 → INVALID_REQUEST error", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({
      type: "upload_attachment",
      requestId: "up-bad",
      session_id: "sess-1",
      filename: "hello.txt",
      content_b64: "not-base64!!!",
    });
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "up-bad",
      command_type: "upload_attachment",
    });
    expect((sent[0] as { message: string }).message).toContain("INVALID_REQUEST");
  });

  it("delete_session_attachments → files_removed 반환", async () => {
    const dir = await mkdtemp(join(tmpdir(), "soul-ts-attachments-"));
    try {
      const store = new FileAttachmentStore(dir);
      await store.saveFileForSession({
        sessionId: "sess-del",
        filename: "a.txt",
        content: Buffer.from("a"),
      });
      const { dispatcher, sent } = createDispatcher({ attachmentStore: store });
      await dispatcher.dispatch({
        type: "delete_session_attachments",
        requestId: "del-1",
        session_id: "sess-del",
      });

      expect(sent[0]).toEqual({
        type: "delete_session_attachments_result",
        requestId: "del-1",
        cleaned: true,
        files_removed: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("download_attachment → base64 content 반환", async () => {
    const dir = await mkdtemp(join(tmpdir(), "soul-ts-attachments-"));
    try {
      const store = new FileAttachmentStore(dir);
      const saved = await store.saveFileForSession({
        sessionId: "sess-dl",
        filename: "image.png",
        content: Buffer.from("png-bytes"),
      });
      const { dispatcher, sent } = createDispatcher({ attachmentStore: store });
      await dispatcher.dispatch({
        type: "download_attachment",
        requestId: "dl-1",
        path: saved.path,
      });

      expect(sent[0]).toMatchObject({
        type: "download_attachment_result",
        requestId: "dl-1",
        content_b64: Buffer.from("png-bytes").toString("base64"),
        content_type: "image/png",
        size: 9,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("download_attachment가 base 밖 path면 INVALID_REQUEST error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "soul-ts-attachments-"));
    try {
      const { dispatcher, sent } = createDispatcher({
        attachmentStore: new FileAttachmentStore(dir),
      });
      await dispatcher.dispatch({
        type: "download_attachment",
        requestId: "dl-bad",
        path: "/etc/passwd",
      });
      expect(sent[0]).toMatchObject({
        type: "error",
        requestId: "dl-bad",
        command_type: "download_attachment",
      });
      expect((sent[0] as { message: string }).message).toContain("INVALID_REQUEST");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CommandDispatcher.list_sessions (Python parity)", () => {
  it("list_sessions → full DB rows → sessions_update wire", async () => {
    // Python `command_handler._handle_list_sessions` L351-359 정합 — `{type:"sessions_update", sessions, total, requestId}`.
    const summaryRows = [
      {
        session_id: "sess-a",
        display_name: "A",
        status: "running",
        session_type: "claude",
        created_at: new Date("2026-05-19T00:00:00Z"),
        updated_at: new Date("2026-05-20T00:00:00Z"),
        event_count: 12,
        away_summary: null,
        caller_session_id: null,
        last_event_id: 12,
        last_read_event_id: 0,
        node_id: "node-1",
      },
      {
        session_id: "sess-b",
        display_name: "B",
        status: "completed",
        session_type: "codex",
        created_at: new Date("2026-05-18T00:00:00Z"),
        updated_at: new Date("2026-05-19T00:00:00Z"),
        event_count: 7,
        away_summary: "지난 세션 요약",
        caller_session_id: "parent-sess",
        last_event_id: 7,
        last_read_event_id: 6,
        node_id: "node-1",
      },
    ];
    const listSessionsForUpstreamDump = vi.fn().mockResolvedValue({
      sessions: summaryRows,
      total: 2,
    });
    const { dispatcher, sent } = createDispatcher({
      sessionDb: { listSessionsForUpstreamDump } as unknown as Partial<SessionDB>,
    });

    await dispatcher.dispatch({ type: "list_sessions", requestId: "list-1" });

    expect(listSessionsForUpstreamDump).toHaveBeenCalledTimes(1);
    expect(listSessionsForUpstreamDump).toHaveBeenCalledWith({
      limit: 10_000,
      offset: 0,
      nodeId: "eias-shopping-ts",
    });
    expect(sent).toHaveLength(1);
    const reply = sent[0] as { type: string; sessions: unknown[]; total: number; requestId: string };
    expect(reply.type).toBe("sessions_update");
    expect(reply.total).toBe(2);
    expect(reply.requestId).toBe("list-1");
    expect(reply.sessions).toHaveLength(2);
    expect((reply.sessions[0] as { session_id: string }).session_id).toBe("sess-a");
  });

  it("list_sessions → requestId 없으면 빈 문자열로 회신 (Python 정합)", async () => {
    const listSessionsForUpstreamDump = vi.fn().mockResolvedValue({
      sessions: [],
      total: 0,
    });
    const { dispatcher, sent } = createDispatcher({
      sessionDb: { listSessionsForUpstreamDump } as unknown as Partial<SessionDB>,
    });

    await dispatcher.dispatch({ type: "list_sessions" });

    expect(sent).toHaveLength(1);
    expect((sent[0] as { requestId: string }).requestId).toBe("");
  });

  it("list_sessions → sessionDb 미주입이면 명시 error", async () => {
    // 정본 분기 — sessionDb dependency가 없으면 silent 응답 대신 명시 에러로 운영자가 누락을 인지.
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ type: "list_sessions", requestId: "list-bad" });

    expect(sent).toHaveLength(1);
    const reply = sent[0] as { type: string; message: string };
    expect(reply.type).toBe("error");
    expect(reply.message).toContain("session_db");
  });
});

describe("CommandDispatcher.plan_agent_profile_update", () => {
  it("delegates to AgentConfigService planProfileUpdate and returns semantic read-only plan", async () => {
    const planProfileUpdate = vi.fn().mockResolvedValue({
      configPath: "/srv/agents.yaml",
      snapshotRoot: "/srv/.local/config-snapshots",
      baseConfigChecksum: "base-checksum",
      configChecksum: "base-checksum",
      changed: true,
      semanticChanges: [
        {
          op: "add_agent",
          agentId: "codex-default",
          before: null,
          after: {
            id: "codex-default",
            name: "Codex Planned",
            backend: "codex",
            workspace_dir: "/tmp/codex",
          },
        },
      ],
      textDiffIncluded: false,
      diff: "",
      config: { agents: [] },
      commentPreservation: "not_preserved",
    });
    const { dispatcher, sent } = createDispatcher({
      agentConfigService: {
        listSnapshots: vi.fn(),
        planProfileUpdate,
        replaceProfile: vi.fn(),
        rollback: vi.fn(),
      },
    });
    const profile = {
      id: "codex-default",
      name: "Codex Planned",
      backend: "codex",
      workspace_dir: "/tmp/codex",
    } as const;

    await dispatcher.dispatch({
      type: "plan_agent_profile_update",
      requestId: "plan-1",
      profile,
      create_if_missing: true,
      include_text_diff: false,
    });

    expect(planProfileUpdate).toHaveBeenCalledWith(profile, true, {
      includeTextDiff: false,
    });
    expect(sent).toEqual([
      {
        type: "plan_agent_profile_update",
        requestId: "plan-1",
        ok: true,
        config_path: "/srv/agents.yaml",
        config_checksum: "base-checksum",
        base_config_checksum: "base-checksum",
        changed: true,
        semantic_changes: [
          {
            op: "add_agent",
            agent_id: "codex-default",
            before: null,
            after: {
              id: "codex-default",
              name: "Codex Planned",
              backend: "codex",
              workspace_dir: "/tmp/codex",
            },
          },
        ],
        text_diff_included: false,
        diff: "",
        snapshot_root: "/srv/.local/config-snapshots",
        comment_preservation: "not_preserved",
      },
    ]);
    expect(JSON.stringify(sent[0])).not.toContain("snapshotPath");
  });

  it("apply_agent_profile_update delegates write with checksum guard and semantic response", async () => {
    let registryForReload: AgentRegistry;
    const reloadedAgents = [
      codexAgent,
      {
        id: "codex-helper",
        name: "Codex Helper",
        backend: "codex",
        workspace_dir: "/tmp/codex-helper",
        model: "gpt-5.3-codex-spark",
        portrait_path: "/tmp/codex-helper.png",
      } as const,
    ];
    const replaceProfile = vi.fn().mockImplementation(async () => {
      registryForReload.replace(reloadedAgents);
      return {
        configPath: "/srv/agents.yaml",
        snapshotRoot: "/srv/.local/config-snapshots",
        baseConfigChecksum: "base-checksum",
        configChecksum: "next-checksum",
        changed: true,
        semanticChanges: [
          {
            op: "replace_agent",
            agentId: "codex-default",
            before: { id: "codex-default", name: "Old" },
            after: {
              id: "codex-default",
              name: "Codex Applied",
              backend: "codex",
              workspace_dir: "/tmp/codex",
            },
          },
        ],
        textDiffIncluded: false,
        diff: "",
        config: { agents: [codexAgent] },
        commentPreservation: "not_preserved",
        snapshotPath: "/srv/.local/config-snapshots/agents.yaml-h/snap.yaml",
        appliedAt: "2026-05-24T00:00:00.000Z",
        reloadOk: true,
      };
    });
    const { dispatcher, sent, registry } = createDispatcher({
      agentConfigService: {
        listSnapshots: vi.fn(),
        planProfileUpdate: vi.fn(),
        replaceProfile,
        rollback: vi.fn(),
      },
    });
    registryForReload = registry;

    await dispatcher.dispatch({
      type: "apply_agent_profile_update",
      requestId: "apply-1",
      profile: codexAgent,
      create_if_missing: true,
      include_text_diff: false,
      expected_config_checksum: "base-checksum",
    });

    expect(replaceProfile).toHaveBeenCalledWith(codexAgent, true, {
      includeTextDiff: false,
      expectedConfigChecksum: "base-checksum",
    });
    expect(sent[0]).toMatchObject({
      type: "apply_agent_profile_update",
      requestId: "apply-1",
      ok: true,
      config_path: "/srv/agents.yaml",
      base_config_checksum: "base-checksum",
      config_checksum: "next-checksum",
      changed: true,
      semantic_changes: [
        expect.objectContaining({
          op: "replace_agent",
          agent_id: "codex-default",
        }),
      ],
      text_diff_included: false,
      diff: "",
      snapshot_path: "/srv/.local/config-snapshots/agents.yaml-h/snap.yaml",
      reload_ok: true,
      agent_count: 2,
      agents: [
        {
          id: "codex-default",
          name: "Codex Default",
          backend: "codex",
          portrait_url: "",
        },
        {
          id: "codex-helper",
          name: "Codex Helper",
          backend: "codex",
          model: "gpt-5.3-codex-spark",
          portrait_url: "/api/agents/codex-helper/portrait",
        },
      ],
      supported_backends: ["codex"],
      capabilities: { max_concurrent: 2 },
    });
  });

  it("list_agents_config_snapshots delegates inventory to service", async () => {
    const listSnapshots = vi.fn().mockReturnValue([
      {
        snapshotId: "snap.yaml",
        snapshotPath: "/srv/.local/config-snapshots/agents.yaml-h/snap.yaml",
        createdAt: "2026-05-24T00:00:00.000Z",
        mtime: "2026-05-24T00:00:00.000Z",
        sizeBytes: 123,
        configPath: "/srv/agents.yaml",
        configName: "agents.yaml",
        configHash: "abc123",
      },
    ]);
    const { dispatcher, sent } = createDispatcher({
      agentConfigService: {
        listSnapshots,
        planProfileUpdate: vi.fn(),
        replaceProfile: vi.fn(),
        rollback: vi.fn(),
      },
    });

    await dispatcher.dispatch({
      type: "list_agents_config_snapshots",
      requestId: "snapshots-1",
    });

    expect(listSnapshots).toHaveBeenCalledTimes(1);
    expect(sent[0]).toMatchObject({
      type: "list_agents_config_snapshots",
      requestId: "snapshots-1",
      ok: true,
      snapshots: [
        expect.objectContaining({
          snapshot_id: "snap.yaml",
          snapshot_path: "/srv/.local/config-snapshots/agents.yaml-h/snap.yaml",
        }),
      ],
    });
  });

  it("rollback_agents_config delegates snapshot id restore with opt-in diff", async () => {
    let registryForReload: AgentRegistry;
    const rollback = vi.fn().mockImplementation(async () => {
      registryForReload.replace([claudeAgent]);
      return {
        configPath: "/srv/agents.yaml",
        snapshotRoot: "/srv/.local/config-snapshots",
        baseConfigChecksum: "changed-checksum",
        configChecksum: "restored-checksum",
        changed: true,
        textDiffIncluded: true,
        diff: "--- agents.yaml\n+++ agents.yaml\n",
        config: { agents: [codexAgent] },
        commentPreservation: "not_preserved",
        snapshotPath: "/srv/.local/config-snapshots/agents.yaml-h/pre-rollback.yaml",
        appliedAt: "2026-05-24T00:00:00.000Z",
        reloadOk: true,
      };
    });
    const { dispatcher, sent, registry } = createDispatcher({
      agentConfigService: {
        listSnapshots: vi.fn(),
        planProfileUpdate: vi.fn(),
        replaceProfile: vi.fn(),
        rollback,
      },
    });
    registryForReload = registry;

    await dispatcher.dispatch({
      type: "rollback_agents_config",
      requestId: "rollback-1",
      snapshot_id: "snap.yaml",
      include_text_diff: true,
    });

    expect(rollback).toHaveBeenCalledWith("snap.yaml", {
      includeTextDiff: true,
    });
    expect(sent[0]).toMatchObject({
      type: "rollback_agents_config",
      requestId: "rollback-1",
      ok: true,
      config_checksum: "restored-checksum",
      text_diff_included: true,
      snapshot_path: "/srv/.local/config-snapshots/agents.yaml-h/pre-rollback.yaml",
      restored_snapshot_id: "snap.yaml",
      agent_count: 1,
      agents: [
        {
          id: "claude-roselin",
          name: "로젤린",
          backend: "claude",
          portrait_url: "",
        },
      ],
      supported_backends: ["claude"],
      capabilities: { max_concurrent: 1 },
    });
  });

  it("returns explicit error when AgentConfigService is not wired", async () => {
    const { dispatcher, sent } = createDispatcher();

    await dispatcher.dispatch({
      type: "plan_agent_profile_update",
      requestId: "plan-missing",
      profile: {
        id: "codex-default",
        name: "Codex Planned",
        backend: "codex",
        workspace_dir: "/tmp/codex",
      },
    });

    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "plan-missing",
      command_type: "plan_agent_profile_update",
    });
    expect((sent[0] as { message: string }).message).toContain("agent_config_service");
  });
});

describe("CommandDispatcher unknown command", () => {
  it("type이 없는 명령은 무시 (응답 없음)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ requestId: "x" });
    expect(sent).toHaveLength(0);
  });

  it("undefined/null 명령은 무시", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch(undefined);
    await dispatcher.dispatch(null);
    expect(sent).toHaveLength(0);
  });
});
