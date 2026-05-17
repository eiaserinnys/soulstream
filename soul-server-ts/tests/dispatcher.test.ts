import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import { AgentRegistry, type AgentProfile } from "../src/agent_registry.js";
import { CommandDispatcher } from "../src/upstream/dispatcher.js";
import type { TaskExecutor } from "../src/task/task_executor.js";
import type { TaskManager } from "../src/task/task_manager.js";
import type { Task } from "../src/task/task_models.js";

const silentLogger = pino({ level: "silent" });

const codexAgent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

function createDispatcher(opts: {
  nodeId?: string;
  agents?: AgentProfile[];
  runningTasks?: number;
  taskManager?: Partial<TaskManager>;
  taskExecutor?: Partial<TaskExecutor>;
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
        model: params.model,
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
  };

  const defaultExecutor: Partial<TaskExecutor> = {
    startExecution: vi.fn(),
  };

  const tm = { ...defaultTaskManager, ...opts.taskManager } as TaskManager;
  const te = { ...defaultExecutor, ...opts.taskExecutor } as TaskExecutor;

  const dispatcher = new CommandDispatcher(
    send,
    silentLogger,
    opts.nodeId ?? "eias-shopping-ts",
    registry,
    tm,
    te,
  );
  return { dispatcher, sent, send, registry, tm, te, createdTasks };
}

describe("CommandDispatcher.health_check", () => {
  it("agentRegistry.length를 max_concurrent로, running task 개수를 active로 박음", async () => {
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
});

describe("CommandDispatcher unknown command", () => {
  it("respond·list_sessions·subscribe_events 등 → Not implemented error", async () => {
    const { dispatcher, sent } = createDispatcher();
    const commands = ["respond", "list_sessions", "subscribe_events"];
    for (const type of commands) {
      await dispatcher.dispatch({ type, requestId: `${type}-id` });
    }
    expect(sent).toHaveLength(3);
    for (let i = 0; i < commands.length; i++) {
      const reply = sent[i] as { type: string; message: string; command_type: string };
      expect(reply.type).toBe("error");
      expect(reply.command_type).toBe(commands[i]);
      expect(reply.message).toContain("Not implemented in soul-server-ts");
    }
  });

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
