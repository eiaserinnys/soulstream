import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type {
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
} from "../../src/engine/protocol.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../../src/engine/claude_options.js";
import { TaskEngineTurnRunner } from "../../src/task/task_engine_turn_runner.js";
import type { Task } from "../../src/task/task_models.js";

const agent: AgentProfile = {
  id: "agent-1",
  name: "Agent",
  backend: "claude",
  workspace_dir: "/tmp/agent",
  allowed_tools: ["Read"],
  disallowed_tools: ["WebFetch"],
  max_turns: 25,
};

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
      maxTurns: 25,
      extraEnv: { [CLAUDE_OAUTH_TOKEN_ENV]: "oauth-token" },
    });
    expect(captured?.onIntervention).toBeUndefined();
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
    expect(captured?.maxTurns).toBe(25);
    expect(captured?.extraEnv).toBeUndefined();
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
      agent: { ...agent, backend: "codex" },
      engine,
      input: { prompt: "turn prompt" },
    }));

    expect(captured?.extraEnv).toBeUndefined();
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

  it("wires Agents snapshot callbacks to the snapshot persistence boundary", async () => {
    const task = makeTask();
    const engine = makeEngine(async (params) => {
      await params.onRunStateSnapshot?.({
        backendId: "openai-agents",
        serialized: "state-v2",
        pendingApprovalId: "tool-1",
      });
      await params.onSessionItemsSnapshot?.({
        backendId: "openai-agents",
        items: [{ role: "user", content: "hi" }],
      });
    });
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
