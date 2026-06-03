import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EnginePort,
  EngineUserInput,
  SSEEventPayload,
  SupportsLiveTurnSteering,
} from "../../src/engine/protocol.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

const claudeAgent: AgentProfile = {
  id: "claude-roselin",
  name: "로젤린",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
};

function makeTask(): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: claudeAgent.id,
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
    if (event.type === "assistant_message" && typeof event.content === "string") {
      task.lastAssistantText = event.content;
    }
  });
  const persistence = { persistEvent, handleSideEffects } as unknown as EventPersistence;

  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;

  return { persistence, db, broadcaster };
}

describe("TaskExecutor live intervention drain", () => {
  it("publishes intervention_sent only after safe callback successfully pushes queued intervention", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    const order: string[] = [];
    const steeredInputs: EngineUserInput[] = [];
    let turnCount = 0;

    const engine: EnginePort & SupportsLiveTurnSteering = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        turnCount += 1;
        if (turnCount === 1) {
          task.interventionQueue.push({ text: "same turn intervention", user: "alice" });
          yield {
            type: "tool_result",
            toolName: "Bash",
            toolUseId: "toolu-1",
            result: "done",
            timestamp: 1,
          } as SSEEventPayload;
          order.push("safe_point_reached");
          await (params as unknown as {
            onSafeInterventionDrain?: () => Promise<boolean>;
          }).onSafeInterventionDrain?.();
          order.push("safe_drain_returned");
          yield {
            type: "assistant_message",
            content: "assistant continued after live drain",
            timestamp: 2,
          } as SSEEventPayload;
          order.push("assistant_yielded");
          yield { type: "complete", result: "first", timestamp: 2 } as SSEEventPayload;
          return;
        }

        yield {
          type: "assistant_message",
          content: "unexpected second turn",
          timestamp: 3,
        } as SSEEventPayload;
        yield { type: "complete", result: "second", timestamp: 3 } as SSEEventPayload;
      },
      async steerActiveTurn(input) {
        order.push(`steer:${input.prompt}`);
        steeredInputs.push(input);
        return { status: "delivered" };
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

    expect(turnCount).toBe(1);
    expect(steeredInputs).toEqual([{ prompt: "same turn intervention" }]);
    expect(task.interventionQueue).toEqual([]);
    expect(order).toEqual([
      "safe_point_reached",
      "steer:same turn intervention",
      "safe_drain_returned",
      "assistant_yielded",
    ]);
    const persistedIntervention = (mocks.persistence as unknown as {
      persistEvent: ReturnType<typeof vi.fn>;
    }).persistEvent.mock.calls.find(([, event]) => event.type === "intervention_sent");
    expect(persistedIntervention?.[1]).toMatchObject({
      type: "intervention_sent",
      text: "same turn intervention",
      user: "alice",
    });
    expect(mocks.broadcaster.emitEventEnvelope).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "same turn intervention",
      }),
    );
    expect(task.lastAssistantText).toBe("assistant continued after live drain");
  });
});
