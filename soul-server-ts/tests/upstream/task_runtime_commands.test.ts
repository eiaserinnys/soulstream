import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import {
  TaskRuntimeCommands,
  UnknownAgentProfileError,
  buildInterveneAck,
  buildSessionCreatedAck,
} from "../../src/upstream/task_runtime_commands.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import type { ModelPreset } from "../../src/model_catalog.js";
import type { NewSessionAgentProfileSource } from "../../src/agent_profile_source.js";

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

const writerOpusAgent: AgentProfile = {
  id: "writer-seosoyoung-opus",
  name: "Writer Seosoyoung Opus",
  backend: "claude",
  workspace_dir: "/tmp/writer-seosoyoung-opus",
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
  agentRegistry?: Pick<AgentRegistry, "get">;
  createTask?: TaskManager["createTask"];
  addIntervention?: TaskManager["addIntervention"];
  startExecution?: TaskExecutor["startExecution"];
  withSessionRecoveryLease?: TaskExecutor["withSessionRecoveryLease"];
  presets?: ModelPreset[];
  agentProfileSource?: NewSessionAgentProfileSource;
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
    withSessionRecoveryLease: opts.withSessionRecoveryLease
      ?? vi.fn(async (_sessionId, operation) => await operation()),
  } as Pick<TaskExecutor, "startExecution" | "withSessionRecoveryLease">;

  const runtime = new TaskRuntimeCommands({
    agentRegistry: opts.agentRegistry ?? {
      get: vi.fn((profileId: string) => agents.get(profileId)),
    },
    taskManager,
    taskExecutor,
    logger,
    ...(opts.presets
      ? {
          modelCatalog: {
            resolve: vi.fn((presetId: string) => {
              const preset = opts.presets?.find((entry) => entry.id === presetId);
              if (!preset) throw new Error(`Unknown model preset: ${presetId}`);
              return preset;
            }),
          },
        }
      : {}),
    ...(opts.agentProfileSource ? { agentProfileSource: opts.agentProfileSource } : {}),
  });

  return { runtime, taskManager, taskExecutor };
}

describe("TaskRuntimeCommands.createSession", () => {
  it("uses the refreshed DB overlay only for a newly created session", async () => {
    const dbAgent = { ...codexAgent, name: "DB Codex", atom_contexts: [] };
    const source: NewSessionAgentProfileSource = {
      resolve: vi.fn(async () => ({
        profile: dbAgent,
        source: "db",
        stale: false,
        hasPortrait: false,
        portraitSource: "none",
      })),
      list: vi.fn(async () => []),
      state: vi.fn(() => ({
        stale: false,
        checkedAt: "2026-08-07T00:00:00.000Z",
        lastError: null,
        counts: { db: 1, yaml: 0 },
      })),
    };
    const { runtime, taskExecutor } = createRuntime({ agentProfileSource: source });

    const task = await runtime.createSession({
      agentSessionId: "sess-db",
      prompt: "new session",
      profileId: codexAgent.id,
    });

    expect(source.resolve).toHaveBeenCalledWith(codexAgent.id);
    expect(taskExecutor.startExecution).toHaveBeenCalledWith(task, dbAgent);
  });
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
      predecessorSessionId: "sess-previous",
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
      predecessorSessionId: "sess-previous",
      callerInfo: { source: "agent", agent_id: "delegator" },
      notifyCompletion: undefined,
      model: "gpt-5",
      oauthToken: undefined,
      reasoningEffort: "medium",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      useMcp: false,
      claudePermissionMode: "default",
      folderId: "folder-1",
      pageAnchor: undefined,
      container: null,
      sourceTaskItemId: null,
      systemPrompt: "system override",
      contextItems,
      attachmentPaths: ["/tmp/a.png", "/tmp/b.txt"],
    });
    expect(taskExecutor.startExecution).toHaveBeenCalledWith(task, codexAgent);
  });

  it("preserves the explicitly selected writer profile through task creation and engine start", async () => {
    const { runtime, taskManager, taskExecutor } = createRuntime({
      agents: [codexAgent, writerOpusAgent],
    });

    const task = await runtime.createSession({
      agentSessionId: "sess-writer-opus",
      prompt: "write with opus",
      profileId: writerOpusAgent.id,
    });

    expect(taskManager.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "writer-seosoyoung-opus" }),
    );
    expect(taskExecutor.startExecution).toHaveBeenCalledWith(task, writerOpusAgent);
  });

  it("resolves an alias to canonical storage while preserving its historical preset", async () => {
    const registry = new AgentRegistry([{
      id: "seosoyoung",
      name: "서소영",
      backend: "codex",
      workspace_dir: "/tmp/seosoyoung",
      default_preset: "codex-sol",
      aliases: [{ id: "seosoyoung-opus", default_preset: "claude-opus" }],
    }]);
    const { runtime, taskManager, taskExecutor } = createRuntime({
      agentRegistry: registry,
      presets: [{
        id: "claude-opus",
        label: "Claude - Opus",
        backend: "claude",
        model: "claude-opus-4-1",
        env: {},
      }],
    });

    const task = await runtime.createSession({
      agentSessionId: "sess-alias",
      prompt: "resume old identity",
      profileId: "seosoyoung-opus",
    });

    expect(taskManager.createTask).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "seosoyoung",
      modelPreset: "claude-opus",
      model: "claude-opus-4-1",
    }));
    expect(taskExecutor.startExecution).toHaveBeenCalledWith(
      task,
      expect.objectContaining({
        id: "seosoyoung",
        default_preset: "claude-opus",
      }),
    );
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

  it("resolves an explicit preset into the persisted model, backend, and env bundle", async () => {
    const { runtime, taskManager } = createRuntime({
      presets: [{
        id: "kimi-2",
        label: "Kimi - 2",
        backend: "claude",
        model: "kimi-for-coding",
        env: {
          ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
          ANTHROPIC_API_KEY: "${KIMI_API_KEY}",
        },
      }],
    });

    await runtime.createSession({
      agentSessionId: "sess-kimi",
      prompt: "inspect",
      profileId: codexAgent.id,
      modelPreset: "kimi-2",
      oauthToken: "claude-token",
    });

    expect(taskManager.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPreset: "kimi-2",
        modelPresetBackend: "claude",
        modelPresetEnv: {
          ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
          ANTHROPIC_API_KEY: "${KIMI_API_KEY}",
        },
        model: "kimi-for-coding",
        oauthToken: "claude-token",
      }),
    );
  });

  it("does not forward a Claude OAuth token when the selected preset backend is Codex", async () => {
    const claudeAgent: AgentProfile = {
      id: "one-profile",
      name: "One profile",
      backend: "claude",
      workspace_dir: "/tmp/one-profile",
    };
    const { runtime, taskManager } = createRuntime({
      agents: [claudeAgent],
      presets: [{
        id: "codex-5.6-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex",
        model: "gpt-5.6-sol",
      }],
    });

    await runtime.createSession({
      agentSessionId: "sess-codex-preset",
      prompt: "inspect",
      profileId: claudeAgent.id,
      modelPreset: "codex-5.6-sol",
      oauthToken: "claude-token",
    });

    expect(taskManager.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPreset: "codex-5.6-sol",
        modelPresetBackend: "codex",
        oauthToken: undefined,
      }),
    );
  });

  it("uses agent.default_preset only when neither preset nor legacy model is explicit", async () => {
    const defaultedAgent: AgentProfile = {
      ...codexAgent,
      default_preset: "codex-5.6-sol",
    };
    const { runtime, taskManager } = createRuntime({
      agents: [defaultedAgent],
      presets: [{
        id: "codex-5.6-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex",
        model: "gpt-5.6-sol",
      }],
    });

    await runtime.createSession({
      agentSessionId: "sess-default",
      prompt: "default",
      profileId: defaultedAgent.id,
    });
    await runtime.createSession({
      agentSessionId: "sess-legacy",
      prompt: "legacy",
      profileId: defaultedAgent.id,
      model: "gpt-legacy-explicit",
    });

    expect(taskManager.createTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        modelPreset: "codex-5.6-sol",
        model: "gpt-5.6-sol",
      }),
    );
    expect(taskManager.createTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: "gpt-legacy-explicit",
      }),
    );
    expect(taskManager.createTask.mock.calls[1]?.[0]).not.toHaveProperty("modelPreset");
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
  it("waits for an imminent restart adoption before routing a runnerless active task", async () => {
    const task = makeTask({ agentSessionId: "sess-restart-adoption", runner: undefined });
    const autoResume = vi.fn(async () => ({ autoResumed: true as const }));
    const runningDelivery = vi.fn(async () => ({ delivered: true as const }));
    const route = new (await import("../../src/task/task_intervention_route.js"))
      .TaskInterventionRoute({
        getTask: () => task,
        loadEvictedTask: vi.fn().mockResolvedValue(null),
        rememberTask: vi.fn(),
        runningInterventionTransition: { deliver: runningDelivery },
        autoResumeTransition: { resume: autoResume },
      });
    const addIntervention = vi.fn((params, onResume) =>
      route.addIntervention(params, onResume));

    let leaseTail = Promise.resolve();
    const withSessionRecoveryLease = vi.fn(async <T>(
      _sessionId: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const previous = leaseTail;
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      leaseTail = previous.then(() => current);
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    });
    let finishAdoption!: () => void;
    const adoptionBarrier = new Promise<void>((resolve) => { finishAdoption = resolve; });
    const adoptionEntered = Promise.withResolvers<void>();
    const adoption = withSessionRecoveryLease(task.agentSessionId, async () => {
      adoptionEntered.resolve();
      await adoptionBarrier;
      task.runner = {
        engine: {} as never,
        eventPersistence: "runner",
        dispatcher: {
          hasActiveExecution: () => true,
        } as never,
      };
    });
    await adoptionEntered.promise;

    const { runtime } = createRuntime({ addIntervention, withSessionRecoveryLease });
    const intervention = runtime.intervene({
      agentSessionId: task.agentSessionId,
      text: "keep this inside the adopted turn",
    });
    await Promise.resolve();

    expect(task.runner).toBeUndefined();
    expect(addIntervention).not.toHaveBeenCalled();

    finishAdoption();
    await adoption;
    await expect(intervention).resolves.toEqual({ delivered: true });
    expect(runningDelivery).toHaveBeenCalledOnce();
    expect(autoResume).not.toHaveBeenCalled();
  });

  it("keeps the session-scoped DB profile on auto-resume instead of refreshing it", async () => {
    const snapshot = { ...codexAgent, name: "DB snapshot" };
    const resumedTask = makeTask({ agentProfileSnapshot: snapshot });
    const addIntervention = vi.fn(async (_params, onResume) => {
      onResume(resumedTask);
      return { autoResumed: true };
    });
    const source = {
      resolve: vi.fn(),
      list: vi.fn(),
      state: vi.fn(() => ({ stale: false, checkedAt: null, lastError: null, counts: { db: 1, yaml: 0 } })),
    } as unknown as NewSessionAgentProfileSource;
    const { runtime, taskExecutor } = createRuntime({ addIntervention, agentProfileSource: source });

    await runtime.intervene({ agentSessionId: resumedTask.agentSessionId, text: "continue" });

    expect(source.resolve).not.toHaveBeenCalled();
    expect(taskExecutor.startExecution).toHaveBeenCalledWith(resumedTask, snapshot);
  });

  it("forwards intervention params and auto-resume callback starts execution with the task profile", async () => {
    const resumedTask = makeTask({ agentSessionId: "sess-resume", profileId: codexAgent.id });
    const extraContextItems = [
      { key: "review", label: "Review", content: "fresh context" },
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

  it("does not report auto-resume success when the persisted profile is unavailable", async () => {
    const resumedTask = makeTask({
      agentSessionId: "sess-missing-profile",
      profileId: "missing-profile",
    });
    const addIntervention = vi.fn(async (_params, onResume) => {
      onResume(resumedTask);
      return { autoResumed: true };
    });
    const { runtime, taskExecutor } = createRuntime({ addIntervention });

    await expect(
      runtime.intervene({
        agentSessionId: "sess-missing-profile",
        text: "continue",
      }),
    ).rejects.toBeInstanceOf(UnknownAgentProfileError);

    expect(taskExecutor.startExecution).not.toHaveBeenCalled();
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
        result: {
          delivered: false,
          queued: true,
          queuePosition: 3,
          consumeWhen: "next_turn",
          reason: "next_turn_required",
        },
      }),
    ).toEqual({
      type: "intervene_ack",
      requestId: "req-queued",
      status: "ok",
      outcome: "queued",
      agentSessionId: "sess-1",
      delivered: false,
      queuePosition: 3,
      consumeWhen: "next_turn",
      reason: "next_turn_required",
    });

    expect(
      buildInterveneAck({
        requestId: "req-queued-unknown",
        agentSessionId: "sess-1",
        result: {
          delivered: false,
          queued: true,
          queuePosition: 1,
          consumeWhen: "next_turn",
          reason: "verdict_unknown",
        },
      }),
    ).toEqual({
      type: "intervene_ack",
      requestId: "req-queued-unknown",
      status: "ok",
      outcome: "queued",
      agentSessionId: "sess-1",
      delivered: false,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "verdict_unknown",
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
      delivered: true,
    });

    expect(
      buildInterveneAck({
        requestId: "req-deferred",
        agentSessionId: "sess-1",
        result: {
          delivered: false,
          deferred: true,
          retryWhen: "engine_available",
          reason: "no_active_turn",
        },
      }),
    ).toEqual({
      type: "intervene_ack",
      requestId: "req-deferred",
      status: "ok",
      outcome: "deferred",
      agentSessionId: "sess-1",
      delivered: false,
      retryWhen: "engine_available",
      reason: "no_active_turn",
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
      delivered: true,
    });

    expect(
      buildInterveneAck({
        requestId: "req-unknown",
        agentSessionId: "sess-1",
        result: {
          delivered: null,
          consumeWhen: null,
          reason: "verdict_unknown",
        },
      }),
    ).toEqual({
      type: "intervene_ack",
      requestId: "req-unknown",
      status: "ok",
      outcome: "unknown",
      agentSessionId: "sess-1",
      delivered: null,
      consumeWhen: null,
      reason: "verdict_unknown",
    });

    expect(
      buildInterveneAck({
        requestId: "req-suppressed",
        agentSessionId: "sess-1",
        result: {
          suppressed: true,
          deliveryId: "77777777-7777-4777-8777-777777777777",
          reason: "delivery_consumed",
        },
      }),
    ).toEqual({
      type: "intervene_ack",
      requestId: "req-suppressed",
      status: "ok",
      outcome: "suppressed",
      agentSessionId: "sess-1",
      deliveryId: "77777777-7777-4777-8777-777777777777",
      delivered: false,
      reason: "delivery_consumed",
    });
  });
});
