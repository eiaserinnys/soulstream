import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { createDetachedClaudeEventBridge } from
  "../../src/runtime/detached_claude_event_bridge.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "../task/event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

const fatalEvent = {
  type: "error",
  fatal: true,
  errorCode: "claude_persistent_query_failed",
  message: "Persistent Claude Query is fatal",
} as const;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-fatal",
    prompt: "hi",
    status: "running",
    createdAt: new Date("2026-11-13T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeExecutor() {
  const double = makeEventPersistenceTestDouble(async () => undefined);
  const executor = new TaskExecutor(
    () => { throw new Error("no engine in this test"); },
    {
      updateSession: vi.fn().mockResolvedValue(undefined),
      setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionDB,
    double.persistence,
    {
      emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
      emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionBroadcaster,
    silentLogger,
  );
  return { executor, double };
}

describe("card #1266 U4 (stuck session 16): an engine that dies with no turn in flight", () => {
  it("hands the fatal detached error of an active task to the termination path after publishing it", async () => {
    const task = makeTask();
    const order: string[] = [];
    const publishEngineEvent = vi.fn(async () => { order.push("publish"); });
    const terminateAfterFatalEngineError = vi.fn(async () => { order.push("terminate"); });
    const bridge = createDetachedClaudeEventBridge({
      logger: silentLogger,
      findTask: () => task,
      getPublisher: () => ({ publishEngineEvent }),
      collectDetached: async () => undefined,
      terminateAfterFatalEngineError,
    });

    await bridge("sess-fatal", { ...fatalEvent } as never);

    expect(order).toEqual(["publish", "terminate"]);
    expect(terminateAfterFatalEngineError).toHaveBeenCalledWith(
      task,
      "Persistent Claude Query is fatal",
    );
  });

  it("leaves a non-fatal detached error alone", async () => {
    const terminateAfterFatalEngineError = vi.fn();
    const bridge = createDetachedClaudeEventBridge({
      logger: silentLogger,
      findTask: () => makeTask(),
      getPublisher: () => ({ publishEngineEvent: vi.fn(async () => undefined) }),
      collectDetached: async () => undefined,
      terminateAfterFatalEngineError,
    });

    await bridge("sess-fatal", { ...fatalEvent, fatal: false } as never);

    expect(terminateAfterFatalEngineError).not.toHaveBeenCalled();
  });

  it("ends an active task with no turn in flight as an error and records the termination event", async () => {
    const { executor, double } = makeExecutor();
    const task = makeTask();

    await executor.terminateAfterFatalEngineError(task, "Persistent Claude Query is fatal");

    expect(task.status).toBe("error");
    expect(task.terminationReason).toBe("error_aborted");
    expect(task.terminationEventRecorded).toBe(true);
    expect(double.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
  });

  it("does not take over a turn that is still in flight", async () => {
    const { executor, double } = makeExecutor();
    const task = makeTask({ executionPromise: new Promise<void>(() => undefined) });

    await executor.terminateAfterFatalEngineError(task, "Persistent Claude Query is fatal");

    expect(task.status).toBe("running");
    expect(double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
  });

  it("ignores a task that already ended", async () => {
    const { executor, double } = makeExecutor();
    const task = makeTask({ status: "completed" });

    await executor.terminateAfterFatalEngineError(task, "Persistent Claude Query is fatal");

    expect(double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
  });
});
