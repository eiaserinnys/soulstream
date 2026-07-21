import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EngineExecuteParams, EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

const claudeAgent: AgentProfile = {
  id: "claude-roselin",
  name: "Roselin",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
};

function makeTask(): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "initial prompt",
    status: "running",
    profileId: claudeAgent.id,
    createdAt: new Date("2026-06-06T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function makeMocks() {
  let nextEventId = 0;
  const persistedEvents: SSEEventPayload[] = [];
  const persistEvent = vi.fn(async (_sessionId: string, event: SSEEventPayload) => {
    persistedEvents.push(event);
    return ++nextEventId;
  });
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

  return { persistence, db, broadcaster, persistedEvents };
}

describe("TaskExecutor query-per-turn intervention queue", () => {
  it("does not duplicate an accepted intervention when it dequeues for the next query", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    const callerInfo = { source: "browser", display_name: "Alice" };
    const turnInputs: EngineExecuteParams[] = [];
    let runningIntervention: RunningInterventionTransition;

    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        turnInputs.push(params);
        if (turnInputs.length === 1) {
          await runningIntervention.deliver(task, {
            text: "same turn intervention",
            user: "alice",
            callerInfo,
            attachmentPaths: ["/tmp/a.png", "/tmp/readme.pdf"],
            context: [{ title: "Trace", body: "line 1" }],
          });
          yield { type: "session", session_id: "claude-sess-1", timestamp: 1 } as SSEEventPayload;
          yield {
            type: "assistant_message",
            content: "first turn done",
            timestamp: 2,
          } as SSEEventPayload;
          yield { type: "complete", result: "first", timestamp: 3 } as SSEEventPayload;
          return;
        }

        yield {
          type: "assistant_message",
          content: "second turn done",
          timestamp: 4,
        } as SSEEventPayload;
        yield { type: "complete", result: "second", timestamp: 5 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };

    runningIntervention = new RunningInterventionTransition({
      broadcaster: mocks.broadcaster,
      logger: silentLogger,
      persistence: mocks.persistence,
      liveRetryDelayMs: 0,
    });

    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );

    executor.startExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[0]).toMatchObject({
      prompt: "initial prompt",
      resumeSessionId: undefined,
    });
    expect(turnInputs[1]?.prompt).toContain("same turn intervention");
    expect(turnInputs[1]?.prompt).toContain("/tmp/readme.pdf");
    expect(turnInputs[1]?.imageAttachmentPaths).toEqual(["/tmp/a.png"]);
    expect(turnInputs[1]?.resumeSessionId).toBe("claude-sess-1");
    expect(task.interventionQueue).toEqual([]);
    expect(task.status).toBe("completed");
    expect(task.lastAssistantText).toBe("second turn done");

    const persistedIntervention = mocks.persistedEvents.find(
      (event) => event.type === "intervention_sent",
    );
    expect(persistedIntervention).toMatchObject({
      type: "intervention_sent",
      text: "same turn intervention",
      user: "alice",
      caller_info: callerInfo,
      attachments: ["/tmp/a.png", "/tmp/readme.pdf"],
      context: [{ title: "Trace", body: "line 1" }],
    });
    expect(
      mocks.persistedEvents.filter((event) => event.type === "intervention_sent"),
    ).toHaveLength(1);
    expect(mocks.broadcaster.emitEventEnvelope).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "same turn intervention",
      }),
    );
  });
});
