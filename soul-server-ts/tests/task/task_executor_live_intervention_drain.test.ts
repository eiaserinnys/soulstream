import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EngineExecuteParams, EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

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
  const persistenceDouble = makeEventPersistenceTestDouble(async (_sessionId, event, task) => {
    if (event.type === "assistant_message" && typeof event.content === "string") {
      task.lastAssistantText = event.content;
    }
  });

  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;

  return { ...persistenceDouble, db, broadcaster };
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
      async intervene() {
        return {
          status: "not_delivered",
          mechanism: "interrupt_then_next_turn",
          reason: "next_turn_required",
        };
      },
    };

    runningIntervention = new RunningInterventionTransition({
      broadcaster: mocks.broadcaster,
      logger: silentLogger,
      persistence: mocks.persistence,
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
    });
    expect(turnInputs[0]).not.toHaveProperty("resumeSessionId");
    expect(turnInputs[1]?.prompt).toContain("same turn intervention");
    expect(turnInputs[1]?.prompt).toContain("/tmp/readme.pdf");
    expect(turnInputs[1]?.imageAttachmentPaths).toEqual(["/tmp/a.png"]);
    expect(turnInputs[1]?.resumeSessionId).toBe("claude-sess-1");
    expect(task.interventionQueue).toEqual([]);
    expect(task.status).toBe("completed");
    expect(task.lastAssistantText).toBe("second turn done");

    const persistedIntervention = mocks.enqueueEvent.mock.calls.find(
      (call) => (call[1] as SSEEventPayload).type === "intervention_sent",
    );
    expect(persistedIntervention?.[1]).toMatchObject({
      type: "intervention_sent",
      text: "same turn intervention",
      user: "alice",
      caller_info: callerInfo,
      attachments: ["/tmp/a.png", "/tmp/readme.pdf"],
      context: [{ title: "Trace", body: "line 1" }],
    });
    expect(
      mocks.enqueueEvent.mock.calls.filter(
        (call) => (call[1] as SSEEventPayload).type === "intervention_sent",
      ),
    ).toHaveLength(1);
    expect(mocks.broadcaster.emitEventEnvelope).not.toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ type: "intervention_sent" }),
    );
  });

  it("auto-resumes a queued delivery after the running turn reaches terminal", async () => {
    const mocks = makeMocks();
    const task = makeTask();
    const turnInputs: EngineExecuteParams[] = [];
    const initialBarrier = deferred<boolean>();
    const message = {
      text: "queued after the first turn",
      user: "alice",
      deliveryId: "35000000-0000-4000-8000-000000000001",
      deliveryIntent: "human_live_steer" as const,
      completionId: "message:35000000-0000-4000-8000-000000000001",
      relationKey: "user_message:sess-1:35000000-0000-4000-8000-000000000001",
    };
    let runningIntervention: RunningInterventionTransition;

    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-roselin",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        turnInputs.push(params);
        yield {
          type: "assistant_message",
          content: turnInputs.length === 1 ? "first response" : "queued response",
        } as SSEEventPayload;
        yield {
          type: "complete",
          result: turnInputs.length === 1 ? "first" : "queued",
        } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
      async intervene() {
        return {
          status: "not_delivered",
          mechanism: "interrupt_then_next_turn",
          reason: "next_turn_required",
        };
      },
    };
    runningIntervention = new RunningInterventionTransition({
      broadcaster: mocks.broadcaster,
      logger: silentLogger,
      persistence: mocks.persistence,
    });
    const autoResume = new AutoResumeTransition({
      logger: silentLogger,
      persistence: mocks.persistence,
    });
    const recordTurnStarted = vi.fn();
    const recordConsumed = vi.fn();
    let executor!: TaskExecutor;
    executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      { recordTurnStarted, recordConsumed, discardIfConsumed: vi.fn() },
      undefined,
      undefined,
      undefined,
      undefined,
      60_000,
      async (terminalTask) => {
        await autoResume.resumeQueuedAfterTerminal(
          terminalTask,
          (resumedTask, activation) =>
            executor.startNewExecution(resumedTask, claudeAgent, activation),
        );
      },
    );

    // The executor has already subscribed to this barrier when it resolves.
    // The earlier callback installs a new running-intervention barrier in the
    // same microtask gap, reproducing the live tail race without a timer.
    task.interruptRequest = initialBarrier.promise;
    const queuedDelivery = initialBarrier.promise.then(() =>
      runningIntervention.deliver(task, message),
    );

    executor.startExecution(task, claudeAgent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    initialBarrier.resolve(false);
    await queuedDelivery;

    await vi.waitFor(() => expect(turnInputs).toHaveLength(2), { timeout: 500 });
    await task.executionPromise;

    expect(turnInputs[1]).toMatchObject({
      prompt: expect.stringContaining(message.text),
    });
    expect(task.lastAssistantText).toBe("queued response");
    expect(task.status).toBe("completed");
    expect(task.interventionQueue).toEqual([]);
    expect(recordTurnStarted).toHaveBeenCalledOnce();
    expect(recordConsumed).toHaveBeenCalledOnce();
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledTimes(2);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
