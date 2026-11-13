import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { createDetachedClaudeEventBridge } from
  "../../src/runtime/detached_claude_event_bridge.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import type { RunnerProcessRuntimeFactory } from "../../src/task/task_executor.js";
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

function makeExecutor(runnerProcessFactory?: RunnerProcessRuntimeFactory) {
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
    undefined, undefined, undefined, undefined, undefined, undefined, // 6~11
    runnerProcessFactory, // 12
  );
  return { executor, double };
}

describe("card #1266 U4 (stuck session 16): an engine that dies with no turn in flight", () => {
  it("hands the fatal detached error of an active task to the termination path after the host call is done", async () => {
    const task = makeTask();
    const order: string[] = [];
    const publishEngineEvent = vi.fn(async () => { order.push("publish"); });
    const collectDetached = vi.fn(async () => { order.push("collect"); });
    const terminateAfterFatalEngineError = vi.fn(async () => { order.push("terminate"); });
    const bridge = createDetachedClaudeEventBridge({
      logger: silentLogger,
      findTask: () => task,
      getPublisher: () => ({ publishEngineEvent }),
      collectDetached,
      terminateAfterFatalEngineError,
    });

    const continueAfterResponse = await bridge("sess-fatal", { ...fatalEvent } as never);
    expect(terminateAfterFatalEngineError).not.toHaveBeenCalled();
    await continueAfterResponse();
    await vi.waitFor(() => expect(terminateAfterFatalEngineError).toHaveBeenCalledOnce());

    expect(order).toEqual(["publish", "collect", "terminate"]);
    expect(terminateAfterFatalEngineError).toHaveBeenCalledWith(
      task,
      "Persistent Claude Query is fatal",
    );
  });

  it("does not hold the host call on a termination that closes the same runner", async () => {
    // 종료가 러너를 닫으면 러너 닫기는 처리 중인 호스트 호출을 기다린다. 그 호출이
    // 종료를 기다리면 서로를 기다려 묶인다.
    const bridge = createDetachedClaudeEventBridge({
      logger: silentLogger,
      findTask: () => makeTask(),
      getPublisher: () => ({ publishEngineEvent: vi.fn(async () => undefined) }),
      collectDetached: async () => undefined,
      terminateAfterFatalEngineError: () => new Promise<void>(() => undefined),
    });

    const continueAfterResponse = await bridge("sess-fatal", { ...fatalEvent } as never);
    await expect(continueAfterResponse()).resolves.toBeUndefined();
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

  it("ends an adopted execution that has no foreground as an error, with one termination event", async () => {
    const agent = { id: "claude-roselin", name: "Roselin", backend: "claude", workspace_dir: "/tmp/claude-roselin" } as AgentProfile;
    const never = new Promise<never>(() => undefined);
    async function* silentFrames() { await never; }
    const dispatcher = {
      dispatch: vi.fn(),
      recoverFrames: vi.fn(() => silentFrames()),
      registrationId: vi.fn(() => "registration-1"),
      hasActiveExecution: vi.fn(() => true),
      interrupt: vi.fn(async () => true),
      close: vi.fn(async () => undefined),
      detachHost: vi.fn(async () => undefined),
      releaseEventStreamRegistration: vi.fn(async () => undefined),
      releaseUnadoptedRecovery: vi.fn(async () => undefined),
      sendControlFrame: vi.fn(async () => true),
      requestContext: vi.fn(),
      waitForSessionAck: vi.fn(async () => 12),
      invoke: vi.fn(),
    };
    const factory = (() => { throw new Error("unused"); }) as unknown as RunnerProcessRuntimeFactory;
    factory.recover = vi.fn(() => ({
      engine: { backendId: "claude", workspaceDir: "/tmp/claude-roselin" } as never,
      dispatcher: dispatcher as never,
      eventPersistence: "runner",
    }));
    const { executor, double } = makeExecutor(factory);
    const task = makeTask({ status: "initializing", profileId: agent.id });
    const adoption = executor.recoverRegisteredRunner(
      task,
      {
        config: { agent, sessionId: task.agentSessionId },
        lifecycle: { execution_command_id: "execute-old", execution_state: "running", terminal_error: null },
      } as unknown as RunnerRegistration,
      "execute-old",
      "adopt",
    );
    adoption.catch(() => undefined);
    await vi.waitFor(() => expect(task.executionPromise).toBeDefined());

    const bridge = createDetachedClaudeEventBridge({
      logger: silentLogger,
      findTask: () => task,
      getPublisher: () => ({ publishEngineEvent: vi.fn(async () => undefined) }),
      collectDetached: async () => undefined,
      terminateAfterFatalEngineError: (t, message) =>
        executor.terminateAfterFatalEngineError(t, message).then(() => undefined),
    });
    const continueAfterResponse = await bridge("sess-fatal", { ...fatalEvent } as never);
    await continueAfterResponse();

    await vi.waitFor(() => expect(task.status).toBe("error"));
    await adoption.catch(() => undefined);
    expect(task.terminationReason).toBe("error_aborted");
    expect(double.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
  });
});
