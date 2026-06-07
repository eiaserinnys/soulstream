import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import type { AgentProfile } from "../../src/agent_registry.js";
import {
  TaskRuntimeCommands,
  UnknownAgentProfileError,
  buildInterveneAck,
  buildSessionCreatedAck,
} from "../../src/upstream/task_runtime_commands.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";

const logger = pino({ level: "silent" });

const codexAgent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

const claudeAgent: AgentProfile = {
  id: "claude-roselin",
  name: "Claude Roselin",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
};

function makeTask(params: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: codexAgent.id,
    createdAt: new Date("2026-05-23T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...params,
  };
}

function createRuntime(opts: {
  agents?: AgentProfile[];
  createTask?: TaskManager["createTask"];
  addIntervention?: TaskManager["addIntervention"];
  startExecution?: TaskExecutor["startExecution"];
} = {}) {
  const agents = new Map(
    (opts.agents ?? [codexAgent]).map((agent) => [agent.id, agent]),
  );
  const taskManager = {
    createTask: opts.createTask ?? vi.fn(async (params) => makeTask(params)),
    addIntervention: opts.addIntervention ?? vi.fn(),
  } as Pick<TaskManager, "createTask" | "addIntervention">;
  const taskExecutor = {
    startExecution: opts.startExecution ?? vi.fn(),
  } as Pick<TaskExecutor, "startExecution">;

  const runtime = new TaskRuntimeCommands({
    agentRegistry: {
      get: vi.fn((profileId: string) => agents.get(profileId)),
    },
    taskManager,
    taskExecutor,
    logger,
  });

  return { runtime, taskManager, taskExecutor };
}

describe("TaskRuntimeCommands.createSession", () => {
  it("creates a task from upstream command params and starts execution with the resolved agent", async () => {
    const contextItems = [
      { key: "external", label: "External", content: "keep this" },
    ];
    const { runtime, taskManager, taskExecutor } = createRuntime();

    const task = await runtime.createSession({
      agentSessionId: "sess-create",
      prompt: "inspect",
      profileId: codexAgent.id,
      callerSessionId: "caller-1",
      callerInfo: { source: "agent", agent_id: "delegator" },
      model: "gpt-5",
      oauthToken: "should-not-pass-to-codex",
      reasoningEffort: "medium",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      useMcp: false,
      claudePermissionMode: "default",
      folderId: "folder-1",
      systemPrompt: "system override",
      extraContextItems: contextItems,
      attachmentPaths: ["/tmp/a.png", "/tmp/b.txt"],
    });

    expect(taskManager.createTask).toHaveBeenCalledWith({
      agentSessionId: "sess-create",
      prompt:
        "inspect\n\n" +
        "[첨부 파일 로컬 경로: /tmp/a.png]\n" +
        "[첨부 파일 로컬 경로: /tmp/b.txt]",
      profileId: codexAgent.id,
      callerSessionId: "caller-1",
      callerInfo: { source: "agent", agent_id: "delegator" },
      model: "gpt-5",
      oauthToken: undefined,
      reasoningEffort: "medium",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      useMcp: false,
      claudePermissionMode: "default",
      folderId: "folder-1",
      systemPrompt: "system override",
      contextItems,
      attachmentPaths: ["/tmp/a.png", "/tmp/b.txt"],
    });
    expect(taskExecutor.startExecution).toHaveBeenCalledWith(task, codexAgent);
  });

  it("appends attachment path notes without duplicating attached-files context", async () => {
    const { runtime, taskManager } = createRuntime();

    await runtime.createSession({
      agentSessionId: "sess-attach",
      prompt: "read files",
      profileId: codexAgent.id,
      attachmentPaths: ["/tmp/image.png", "/tmp/notes.md"],
    });

    expect(taskManager.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt:
          "read files\n\n" +
          "[첨부 파일 로컬 경로: /tmp/image.png]\n" +
          "[첨부 파일 로컬 경로: /tmp/notes.md]",
        contextItems: undefined,
        attachmentPaths: ["/tmp/image.png", "/tmp/notes.md"],
      }),
    );
  });

  it("passes trimmed oauth token only for Claude backend profiles", async () => {
    const { runtime, taskManager } = createRuntime({
      agents: [codexAgent, claudeAgent],
    });

    await runtime.createSession({
      agentSessionId: "sess-claude",
      prompt: "use claude",
      profileId: claudeAgent.id,
      oauthToken: "  claude-token  ",
    });
    await runtime.createSession({
      agentSessionId: "sess-codex",
      prompt: "use codex",
      profileId: codexAgent.id,
      oauthToken: "codex-ignored",
    });

    expect(taskManager.createTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ oauthToken: "claude-token" }),
    );
    expect(taskManager.createTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ oauthToken: undefined }),
    );
  });

  it("fails before task creation when profile id is unknown", async () => {
    const { runtime, taskManager, taskExecutor } = createRuntime();

    await expect(
      runtime.createSession({
        agentSessionId: "sess-missing",
        prompt: "hi",
        profileId: "missing-profile",
      }),
    ).rejects.toBeInstanceOf(UnknownAgentProfileError);
    expect(taskManager.createTask).not.toHaveBeenCalled();
    expect(taskExecutor.startExecution).not.toHaveBeenCalled();
  });
});

describe("TaskRuntimeCommands.intervene", () => {
  it("forwards intervention params and auto-resume callback starts execution with the task profile", async () => {
    const resumedTask = makeTask({ agentSessionId: "sess-resume", profileId: codexAgent.id });
    const extraContextItems = [
      { key: "supervisor", label: "Supervisor", content: "fresh context" },
    ];
    const addIntervention = vi.fn(async (_params, onResume) => {
      onResume(resumedTask);
      return { autoResumed: true };
    });
    const { runtime, taskManager, taskExecutor } = createRuntime({ addIntervention });

    const result = await runtime.intervene({
      agentSessionId: "sess-resume",
      text: "continue",
      callerInfo: { source: "agent" },
      attachmentPaths: ["/tmp/context.txt"],
      extraContextItems,
    });

    expect(taskManager.addIntervention).toHaveBeenCalledWith(
      {
        agentSessionId: "sess-resume",
        text: "continue\n\n[첨부 파일 로컬 경로: /tmp/context.txt]",
        user: "upstream",
        callerInfo: { source: "agent" },
        attachmentPaths: ["/tmp/context.txt"],
        context: extraContextItems,
      },
      expect.any(Function),
    );
    expect(taskExecutor.startExecution).toHaveBeenCalledWith(resumedTask, codexAgent);
    expect(result).toEqual({ autoResumed: true });
  });

  it("completed+evicted Claude auto-resume starts execution with the persisted Claude profile", async () => {
    const resumedTask = makeTask({
      agentSessionId: "sess-evicted-claude",
      profileId: claudeAgent.id,
      hydratedFromDb: true,
      sessionType: "claude",
      codexThreadId: "736ddf46-4c72-4b02-a44a-fab3e5e58fe5",
      lastEventId: 581,
    });
    const addIntervention = vi.fn(async (_params, onResume) => {
      onResume(resumedTask);
      return { autoResumed: true };
    });
    const { runtime, taskExecutor } = createRuntime({
      agents: [codexAgent, claudeAgent],
      addIntervention,
    });

    const result = await runtime.intervene({
      agentSessionId: "sess-evicted-claude",
      text: "continue after completion",
      user: "browser",
    });

    expect(addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-evicted-claude",
        text: "continue after completion",
        user: "browser",
      }),
      expect.any(Function),
    );
    expect(taskExecutor.startExecution).toHaveBeenCalledWith(resumedTask, claudeAgent);
    expect(result).toEqual({ autoResumed: true });
  });
});

describe("TaskRuntimeCommands ACK builders", () => {
  it("builds stable session_created ACK", () => {
    expect(buildSessionCreatedAck({ requestId: "req-1", agentSessionId: "sess-1" })).toEqual({
      type: "session_created",
      requestId: "req-1",
      agentSessionId: "sess-1",
    });
  });

  it("maps intervention route results to stable intervene_ack outcomes", () => {
    expect(
      buildInterveneAck({
        requestId: "req-queued",
        agentSessionId: "sess-1",
        result: { queued: true, queuePosition: 3 },
      }),
    ).toEqual({
      type: "intervene_ack",
      requestId: "req-queued",
      status: "ok",
      outcome: "queued",
      queuePosition: 3,
    });

    expect(
      buildInterveneAck({
        requestId: "req-resumed",
        agentSessionId: "sess-1",
        result: { autoResumed: true },
      }),
    ).toEqual({
      type: "intervene_ack",
      requestId: "req-resumed",
      status: "ok",
      outcome: "auto_resumed",
      agentSessionId: "sess-1",
    });

    expect(
      buildInterveneAck({
        requestId: "req-delivered",
        agentSessionId: "sess-1",
        result: { delivered: true },
      }),
    ).toEqual({
      type: "intervene_ack",
      requestId: "req-delivered",
      status: "ok",
      outcome: "delivered",
      agentSessionId: "sess-1",
    });
  });
});
