import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type {
  EngineExecuteParams,
  EnginePort,
  ScheduleToolUseHandler,
  SSEEventPayload,
} from "../../src/engine/protocol.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../../src/engine/claude_options.js";
import { readClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import {
  engineEventFrame,
  RUNNER_FRAME_PROTOCOL_VERSION,
  runnerRequestFrame,
} from "../../src/runner/frame_protocol.js";
import {
  DEFAULT_RUNNER_REQUEST_TIMEOUT_MS,
  InProcessRunnerFrameChannel,
} from "../../src/runner/in_process_frame_channel.js";
import { TaskEngineTurnRunner } from "../../src/task/task_engine_turn_runner.js";
import type { Task } from "../../src/task/task_models.js";

const agent: AgentProfile = {
  id: "agent-1",
  name: "Agent",
  backend: "claude",
  workspace_dir: "/tmp/agent",
  allowed_tools: ["Read"],
  disallowed_tools: ["WebFetch"],
  claude_permission_mode: "acceptEdits",
  max_turns: 25,
};

const TEST_ENV_KEYS = [
  "SOULSTREAM_TEST_KIMI_API_KEY",
  "SOULSTREAM_TEST_RESUME_API_KEY",
] as const;
const ORIGINAL_TEST_ENV = new Map(
  TEST_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-turn-runner",
    prompt: "original prompt",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeEngine(
  onExecute: (params: EngineExecuteParams) => void | Promise<void>,
): EnginePort {
  return {
    backendId: "claude",
    workspaceDir: "/tmp/agent",
    async *execute(params): AsyncIterable<SSEEventPayload> {
      await onExecute(params);
      yield { type: "complete", result: "done", timestamp: 1 } as SSEEventPayload;
    },
    async interrupt() { return true; },
    async close() {},
  };
}

function makeSubject() {
  const snapshotPersistence = {
    persistRunStateSnapshot: vi.fn().mockResolvedValue(undefined),
    persistSessionItemsSnapshot: vi.fn().mockResolvedValue(undefined),
  };
  const runner = new TaskEngineTurnRunner({ snapshotPersistence });
  return { runner, snapshotPersistence };
}

async function drain(iterable: AsyncIterable<SSEEventPayload>): Promise<SSEEventPayload[]> {
  const events: SSEEventPayload[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("TaskEngineTurnRunner", () => {
  afterEach(() => {
    for (const key of TEST_ENV_KEYS) {
      const original = ORIGINAL_TEST_ENV.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it("assembles one engine turn from task runtime policy and turn input", async () => {
    const task = makeTask({
      codexThreadId: "claude-sess-1",
      model: "claude-sonnet-4.5",
      reasoningEffort: "low",
      oauthToken: "oauth-token",
      agentsRunState: "state-v1",
      agentsPreviousResponseId: "resp-1",
      agentsConversationId: "conv-1",
      agentsSessionItems: [{ role: "system", content: "old" }],
      allowedTools: ["Bash"],
      disallowedTools: ["Edit"],
      useMcp: false,
      claudePermissionMode: "default",
    });
    let captured: EngineExecuteParams | undefined;
    const engine = makeEngine((params) => {
      captured = params;
    });
    const { runner } = makeSubject();

    await drain(runner.executeTurn({
      task,
      agent,
      engine,
      input: {
        prompt: "turn prompt",
        imageAttachmentPaths: ["/tmp/a.png"],
        systemPrompt: "system prompt",
        inputUuid: "22222222-2222-5222-8222-222222222222",
      },
    }));

    expect(captured).toMatchObject({
      prompt: "turn prompt",
      imageAttachmentPaths: ["/tmp/a.png"],
      model: "claude-sonnet-4.5",
      reasoningEffort: "low",
      resumeSessionId: "claude-sess-1",
      resumeRunState: "state-v1",
      previousResponseId: "resp-1",
      conversationId: "conv-1",
      sessionItems: [{ role: "system", content: "old" }],
      systemPrompt: "system prompt",
      allowedTools: ["Bash"],
      disallowedTools: ["Edit"],
      useMcp: false,
      claudePermissionMode: "default",
      maxTurns: 25,
      inputUuid: "22222222-2222-5222-8222-222222222222",
      extraEnv: { [CLAUDE_OAUTH_TOKEN_ENV]: "oauth-token" },
    });
    expect(captured?.onIntervention).toBeUndefined();
  });

  it("consumes engine events and snapshots from the in-process runner frame stream", async () => {
    const task = makeTask();
    const engine: EnginePort = {
      backendId: "openai-agents",
      workspaceDir: "/tmp/agent",
      async *execute(): AsyncIterable<SSEEventPayload> {
        throw new Error("legacy execute path must not be used");
      },
      async *executeFrames() {
        yield engineEventFrame({ type: "session", session_id: "agents-1" });
        yield {
          protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
          channel: "event" as const,
          kind: "run_state_snapshot" as const,
          snapshot: { backendId: "openai-agents" as const, serialized: "state-1" },
        };
        yield {
          protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
          channel: "event" as const,
          kind: "session_items_snapshot" as const,
          snapshot: { backendId: "openai-agents" as const, items: [{ role: "user" }] },
        };
        yield engineEventFrame({ type: "complete", result: "done", timestamp: 1 });
      },
      async interrupt() { return true; },
      async close() {},
    };
    const { runner, snapshotPersistence } = makeSubject();

    const events = await drain(runner.executeTurn({
      task,
      agent: { ...agent, backend: "openai-agents" },
      engine,
      input: { prompt: "turn prompt" },
    }));

    expect(events.map((event) => event.type)).toEqual(["session", "complete"]);
    expect(snapshotPersistence.persistRunStateSnapshot).toHaveBeenCalledWith(
      task,
      { backendId: "openai-agents", serialized: "state-1" },
    );
    expect(snapshotPersistence.persistSessionItemsSnapshot).toHaveBeenCalledWith(
      task,
      { backendId: "openai-agents", items: [{ role: "user" }] },
    );
  });

  it("restores Claude frame metadata on the production turn consumer", async () => {
    const task = makeTask();
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/agent",
      async *execute(): AsyncIterable<SSEEventPayload> {},
      async *executeFrames() {
        yield engineEventFrame(
          { type: "task_notification", task_id: "task-1" },
          { claudeBackgroundProvenance: "sdk_membership" },
        );
      },
      async interrupt() { return true; },
      async close() {},
    };
    const { runner } = makeSubject();

    const [event] = await drain(runner.executeTurn({
      task,
      agent,
      engine,
      input: { prompt: "turn prompt" },
    }));

    expect(event).toBeDefined();
    expect(readClaudeBackgroundProvenance(event!)).toBe("sdk_membership");
  });

  it("answers schedule request frames through the correlated control boundary", async () => {
    const task = makeTask();
    const scheduleToolHandler = vi.fn().mockResolvedValue({
      message: "scheduled",
      data: { scheduleId: "schedule-1" },
    });
    const snapshotPersistence = {
      persistRunStateSnapshot: vi.fn().mockResolvedValue(undefined),
      persistSessionItemsSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    let controlFrame: unknown;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/agent",
      async *execute(): AsyncIterable<SSEEventPayload> {},
      async *executeFrames(params) {
        expect(params.scheduleToolUseEnabled).toBe(true);
        yield {
          protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
          channel: "event" as const,
          kind: "request" as const,
          correlationId: "schedule-request-1",
          request: {
            kind: "schedule_tool_use" as const,
            agentSessionId: task.agentSessionId,
            toolUseId: "tool-use-1",
            toolName: "ScheduleTask",
            input: { prompt: "later" },
            now: "2026-08-10T12:00:00.000Z",
          },
        };
        yield engineEventFrame({ type: "complete", result: "done", timestamp: 1 });
      },
      sendControlFrame(frame) {
        controlFrame = frame;
        return true;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const runner = new TaskEngineTurnRunner({ snapshotPersistence, scheduleToolHandler });

    await drain(runner.executeTurn({ task, agent, engine, input: { prompt: "turn" } }));

    expect(scheduleToolHandler).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: task.agentSessionId,
      toolUseId: "tool-use-1",
      toolName: "ScheduleTask",
      input: { prompt: "later" },
      now: new Date("2026-08-10T12:00:00.000Z"),
      signal: expect.any(AbortSignal),
      timeoutMs: DEFAULT_RUNNER_REQUEST_TIMEOUT_MS,
    }));
    expect(controlFrame).toMatchObject({
      kind: "response",
      correlationId: "schedule-request-1",
      result: {
        status: "ok",
        data: { message: "scheduled", data: { scheduleId: "schedule-1" } },
      },
    });
  });

  it("passes the channel abort signal to an unanswered handler and drains on interrupt", async () => {
    const task = makeTask();
    const channel = new InProcessRunnerFrameChannel();
    const controller = new AbortController();
    let hostSignal: AbortSignal | undefined;
    let notifyHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      notifyHandlerStarted = resolve;
    });
    const scheduleToolHandler: ScheduleToolUseHandler = async (request) => {
      hostSignal = request.signal;
      notifyHandlerStarted();
      return await new Promise<never>(() => undefined);
    };
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/agent",
      async *execute(): AsyncIterable<SSEEventPayload> {},
      executeFrames() {
        channel.start(async () => {
          try {
            await channel.request(runnerRequestFrame("schedule-interrupt", {
              kind: "schedule_tool_use",
              agentSessionId: task.agentSessionId,
              toolUseId: "tool-use-interrupt",
              toolName: "ScheduleTask",
              input: {},
              now: "2026-08-10T12:00:00.000Z",
            }, { timeoutMs: 1_000 }), {
              signal: controller.signal,
              timeoutMs: 1_000,
            });
          } catch (error) {
            if (!controller.signal.aborted) throw error;
          }
        });
        return channel;
      },
      sendControlFrame(frame) {
        return channel.sendControl(frame);
      },
      async interrupt() {
        controller.abort(new Error("interrupted"));
        return true;
      },
      async close() {},
    };
    const runner = new TaskEngineTurnRunner({
      snapshotPersistence: {
        persistRunStateSnapshot: vi.fn(),
        persistSessionItemsSnapshot: vi.fn(),
      },
      scheduleToolHandler,
    });

    const execution = drain(runner.executeTurn({ task, agent, engine, input: { prompt: "turn" } }));
    await handlerStarted;

    expect(hostSignal).toBe(channel.requestContext("schedule-interrupt")?.signal);
    await engine.interrupt();

    await expect(execution).resolves.toEqual([]);
    expect(hostSignal?.aborted).toBe(true);
    expect(channel.pendingControlCount).toBe(0);
  });

  it("returns schedule handler failures as correlated error controls", async () => {
    const task = makeTask();
    const scheduleToolHandler = vi.fn().mockRejectedValue(new Error("scheduler unavailable"));
    let controlFrame: unknown;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/agent",
      async *execute(): AsyncIterable<SSEEventPayload> {},
      async *executeFrames() {
        yield {
          protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
          channel: "event" as const,
          kind: "request" as const,
          correlationId: "schedule-request-error",
          request: {
            kind: "schedule_tool_use" as const,
            agentSessionId: task.agentSessionId,
            toolUseId: "tool-use-error",
            toolName: "ScheduleTask",
            input: {},
            now: "2026-08-10T12:00:00.000Z",
          },
        };
      },
      sendControlFrame(frame) {
        controlFrame = frame;
        return true;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const runner = new TaskEngineTurnRunner({
      snapshotPersistence: {
        persistRunStateSnapshot: vi.fn(),
        persistSessionItemsSnapshot: vi.fn(),
      },
      scheduleToolHandler,
    });

    await drain(runner.executeTurn({ task, agent, engine, input: { prompt: "turn" } }));

    expect(controlFrame).toMatchObject({
      kind: "response",
      correlationId: "schedule-request-error",
      result: {
        status: "error",
        error: { code: "schedule_handler_error", message: "scheduler unavailable" },
      },
    });
  });

  it("falls back to agent tool policy when task-level policy is absent", async () => {
    const task = makeTask();
    let captured: EngineExecuteParams | undefined;
    const engine = makeEngine((params) => {
      captured = params;
    });
    const { runner } = makeSubject();

    await drain(runner.executeTurn({
      task,
      agent,
      engine,
      input: { prompt: "turn prompt", imageAttachmentPaths: [] },
    }));

    expect(captured?.allowedTools).toEqual(["Read"]);
    expect(captured?.disallowedTools).toEqual(["WebFetch"]);
    expect(captured?.claudePermissionMode).toBe("acceptEdits");
    expect(captured?.maxTurns).toBe(25);
    expect(captured?.model).toBeUndefined();
    expect(captured?.extraEnv).toBeUndefined();
  });

  it("uses agent model when task-level model is absent", async () => {
    const task = makeTask();
    let captured: EngineExecuteParams | undefined;
    const engine = makeEngine((params) => {
      captured = params;
    });
    const { runner } = makeSubject();

    await drain(runner.executeTurn({
      task,
      agent: { ...agent, model: "gpt-5.3-codex-spark" },
      engine,
      input: { prompt: "turn prompt", imageAttachmentPaths: [] },
    }));

    expect(captured?.model).toBe("gpt-5.3-codex-spark");
  });

  it("keeps task-level model override above agent model", async () => {
    const task = makeTask({ model: "gpt-5.5" });
    let captured: EngineExecuteParams | undefined;
    const engine = makeEngine((params) => {
      captured = params;
    });
    const { runner } = makeSubject();

    await drain(runner.executeTurn({
      task,
      agent: { ...agent, model: "gpt-5.3-codex-spark" },
      engine,
      input: { prompt: "turn prompt", imageAttachmentPaths: [] },
    }));

    expect(captured?.model).toBe("gpt-5.5");
  });

  it("does not forward Claude oauthToken to non-Claude backends", async () => {
    const task = makeTask({ oauthToken: "oauth-token" });
    let captured: EngineExecuteParams | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/agent",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        captured = params;
        yield { type: "complete", result: "done", timestamp: 1 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const { runner } = makeSubject();

    await drain(runner.executeTurn({
      task,
      agent: {
        ...agent,
        backend: "codex",
        env: {
          ANTHROPIC_API_KEY: "kimi-secret",
          ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
        },
      } as AgentProfile,
      engine,
      input: { prompt: "turn prompt" },
    }));

    expect(captured?.extraEnv).toBeUndefined();
  });

  it("resolves profile env refs and skips task OAuth for Anthropic API key auth", async () => {
    process.env.SOULSTREAM_TEST_KIMI_API_KEY = "kimi-secret";
    const task = makeTask({ oauthToken: "oauth-token" });
    let captured: EngineExecuteParams | undefined;
    const engine = makeEngine((params) => {
      captured = params;
    });
    const { runner } = makeSubject();

    await drain(runner.executeTurn({
      task,
      agent: {
        ...agent,
        env: {
          ANTHROPIC_API_KEY: "${SOULSTREAM_TEST_KIMI_API_KEY}",
          ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
        },
      } as AgentProfile,
      engine,
      input: { prompt: "turn prompt" },
    }));

    expect(captured?.extraEnv).toEqual({
      ANTHROPIC_API_KEY: "kimi-secret",
      ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
    });
    expect(captured?.extraEnv).not.toHaveProperty(CLAUDE_OAUTH_TOKEN_ENV);
  });

  it("prefers the model preset env bundle over the legacy profile env bundle", async () => {
    process.env.SOULSTREAM_TEST_KIMI_API_KEY = "preset-kimi-secret";
    const task = makeTask({
      oauthToken: "oauth-token",
      modelPresetBackend: "claude",
      modelPresetEnv: {
        ANTHROPIC_API_KEY: "${SOULSTREAM_TEST_KIMI_API_KEY}",
        ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
      },
    });
    let captured: EngineExecuteParams | undefined;
    const engine = makeEngine((params) => {
      captured = params;
    });
    const { runner } = makeSubject();

    await drain(runner.executeTurn({
      task,
      agent: {
        ...agent,
        env: {
          ANTHROPIC_API_KEY: "legacy-profile-secret",
          ANTHROPIC_BASE_URL: "https://legacy.example/anthropic",
        },
      } as AgentProfile,
      engine,
      input: { prompt: "turn prompt" },
    }));

    expect(captured?.extraEnv).toEqual({
      ANTHROPIC_API_KEY: "preset-kimi-secret",
      ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
    });
    expect(captured?.extraEnv).not.toHaveProperty(CLAUDE_OAUTH_TOKEN_ENV);
  });

  it("uses native OAuth without inheriting legacy profile env when a preset has no env bundle", async () => {
    const task = makeTask({
      modelPreset: "claude-opus",
      modelPresetBackend: "claude",
      oauthToken: "oauth-token",
    });
    let captured: EngineExecuteParams | undefined;
    const engine = makeEngine((params) => {
      captured = params;
    });
    const { runner } = makeSubject();

    await drain(runner.executeTurn({
      task,
      agent: {
        ...agent,
        env: {
          ANTHROPIC_API_KEY: "legacy-kimi-secret",
          ANTHROPIC_BASE_URL: "https://legacy.example/anthropic",
        },
      } as AgentProfile,
      engine,
      input: { prompt: "turn prompt" },
    }));

    expect(captured?.extraEnv).toEqual({
      [CLAUDE_OAUTH_TOKEN_ENV]: "oauth-token",
    });
  });

  it("applies profile env on resumed turns", async () => {
    process.env.SOULSTREAM_TEST_RESUME_API_KEY = "resume-kimi-secret";
    const task = makeTask({
      codexThreadId: "claude-sess-1",
      oauthToken: "oauth-token",
    });
    let captured: EngineExecuteParams | undefined;
    const engine = makeEngine((params) => {
      captured = params;
    });
    const { runner } = makeSubject();

    await drain(runner.executeTurn({
      task,
      agent: {
        ...agent,
        env: {
          ANTHROPIC_API_KEY: "${SOULSTREAM_TEST_RESUME_API_KEY}",
          ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
        },
      } as AgentProfile,
      engine,
      input: { prompt: "resume prompt" },
    }));

    expect(captured?.resumeSessionId).toBe("claude-sess-1");
    expect(captured?.extraEnv).toEqual({
      ANTHROPIC_API_KEY: "resume-kimi-secret",
      ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
    });
  });

  it("fails clearly when a profile env reference is missing", () => {
    const task = makeTask();
    const engine = makeEngine(() => undefined);
    const { runner } = makeSubject();

    expect(() =>
      runner.executeTurn({
        task,
        agent: {
          ...agent,
          env: {
            ANTHROPIC_API_KEY: "${SOULSTREAM_TEST_MISSING_API_KEY}",
            ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
          },
        } as AgentProfile,
        engine,
        input: { prompt: "turn prompt" },
      }),
    ).toThrow(
      /agents\.yaml env 'ANTHROPIC_API_KEY' references missing environment variable 'SOULSTREAM_TEST_MISSING_API_KEY'/,
    );
  });

  it("labels unresolved preset env separately from legacy agents.yaml env", () => {
    const task = makeTask({
      modelPresetBackend: "claude",
      modelPresetEnv: {
        ANTHROPIC_API_KEY: "${SOULSTREAM_TEST_MISSING_PRESET_API_KEY}",
        ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
      },
    });
    const engine = makeEngine(() => undefined);
    const { runner } = makeSubject();

    expect(() =>
      runner.executeTurn({
        task,
        agent,
        engine,
        input: { prompt: "turn prompt" },
      }),
    ).toThrow(
      /model preset env 'ANTHROPIC_API_KEY' references missing environment variable 'SOULSTREAM_TEST_MISSING_PRESET_API_KEY'/,
    );
  });

  it("rejects Anthropic API key without matching base URL", () => {
    const task = makeTask();
    const engine = makeEngine(() => undefined);
    const { runner } = makeSubject();

    expect(() =>
      runner.executeTurn({
        task,
        agent: {
          ...agent,
          env: {
            ANTHROPIC_API_KEY: "kimi-secret",
          },
        } as AgentProfile,
        engine,
        input: { prompt: "turn prompt" },
      }),
    ).toThrow(/ANTHROPIC_API_KEY.*ANTHROPIC_BASE_URL/);
  });

  it("rejects Anthropic base URL without matching API key", () => {
    const task = makeTask();
    const engine = makeEngine(() => undefined);
    const { runner } = makeSubject();

    expect(() =>
      runner.executeTurn({
        task,
        agent: {
          ...agent,
          env: {
            ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
          },
        } as AgentProfile,
        engine,
        input: { prompt: "turn prompt" },
      }),
    ).toThrow(/ANTHROPIC_API_KEY.*ANTHROPIC_BASE_URL/);
  });

  it("rejects profile env that mixes Anthropic API key with Claude OAuth token", () => {
    const task = makeTask();
    const engine = makeEngine(() => undefined);
    const { runner } = makeSubject();

    expect(() =>
      runner.executeTurn({
        task,
        agent: {
          ...agent,
          env: {
            ANTHROPIC_API_KEY: "kimi-secret",
            ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
            [CLAUDE_OAUTH_TOKEN_ENV]: "oauth-token",
          },
        } as AgentProfile,
        engine,
        input: { prompt: "turn prompt" },
      }),
    ).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("consumes a queued tool approval exactly once before the engine turn starts", () => {
    const queuedToolApproval = {
      approvalId: "tool-1",
      decision: "approved" as const,
      options: { alwaysApprove: true },
    };
    const task = makeTask({ agentsQueuedToolApproval: queuedToolApproval });
    let captured: EngineExecuteParams | undefined;
    const engine: EnginePort = {
      backendId: "openai-agents",
      workspaceDir: "/tmp/agent",
      execute(params): AsyncIterable<SSEEventPayload> {
        captured = params;
        return (async function* () {
          yield { type: "complete", result: "done", timestamp: 1 } as SSEEventPayload;
        })();
      },
      async interrupt() { return true; },
      async close() {},
    };
    const { runner } = makeSubject();

    const iterable = runner.executeTurn({
      task,
      agent: { ...agent, backend: "openai-agents" },
      engine,
      input: { prompt: "resume", imageAttachmentPaths: [] },
    });

    expect(task.agentsQueuedToolApproval).toBeUndefined();
    expect(captured?.queuedToolApproval).toEqual(queuedToolApproval);
    expect(iterable).toBeDefined();

    let secondCaptured: EngineExecuteParams | undefined;
    runner.executeTurn({
      task,
      agent: { ...agent, backend: "openai-agents" },
      engine: {
        ...engine,
        execute(params): AsyncIterable<SSEEventPayload> {
          secondCaptured = params;
          return (async function* () {
            yield { type: "complete", result: "done again", timestamp: 2 } as SSEEventPayload;
          })();
        },
      },
      input: { prompt: "resume again", imageAttachmentPaths: [] },
    });

    expect(secondCaptured?.queuedToolApproval).toBeUndefined();
  });

  it("wires Agents snapshot frames to the snapshot persistence boundary", async () => {
    const task = makeTask();
    const engine: EnginePort = {
      backendId: "openai-agents",
      workspaceDir: "/tmp/agent",
      async *execute(): AsyncIterable<SSEEventPayload> {},
      async *executeFrames() {
        yield {
          protocolVersion: RUNNER_FRAME_PROTOCOL_VERSION,
          channel: "event" as const,
          kind: "run_state_snapshot" as const,
          snapshot: {
            backendId: "openai-agents" as const,
            serialized: "state-v2",
            pendingApprovalId: "tool-1",
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
      },
      async interrupt() { return true; },
      async close() {},
    };
    const { runner, snapshotPersistence } = makeSubject();

    await drain(runner.executeTurn({
      task,
      agent: { ...agent, backend: "openai-agents" },
      engine,
      input: { prompt: "resume", imageAttachmentPaths: [] },
    }));

    expect(snapshotPersistence.persistRunStateSnapshot).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ serialized: "state-v2" }),
    );
    expect(snapshotPersistence.persistSessionItemsSnapshot).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ items: [{ role: "user", content: "hi" }] }),
    );
  });
});
