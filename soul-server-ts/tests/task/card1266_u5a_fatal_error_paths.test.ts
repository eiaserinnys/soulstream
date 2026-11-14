import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { RunnerProcessRuntimeFactory } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

/**
 * 카드 #1266 U5a 가·나: 읽기 장치가 없거나 이미 풀린 뒤에 온 엔진 치명 오류가 버려지지 않는다.
 */
const logger = pino({ level: "silent" });

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-u5a-fatal",
    prompt: "hi",
    status: "running",
    createdAt: new Date("2026-11-14T01:00:00.000Z"),
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
    logger,
    undefined, undefined, undefined, undefined, undefined, undefined, // 6~11
    runnerProcessFactory, // 12
  );
  return { executor, double };
}

type FatalSignal = { fail(error: Error): void; readonly waiters: number };
const wrap = (executor: TaskExecutor, task: Task, source: AsyncIterable<number>) =>
  (executor as unknown as {
    failOnFatalEngineError(task: Task, source: AsyncIterable<number>): AsyncIterable<number>;
  }).failOnFatalEngineError(task, source);
const signalOf = (executor: TaskExecutor, task: Task) =>
  (executor as unknown as { fatalEngineErrorFailers: WeakMap<Task, FatalSignal> })
    .fatalEngineErrorFailers.get(task);
const holdSlot = (executor: TaskExecutor, task: Task, promise: Promise<void>) =>
  (executor as unknown as {
    holdExecutionSlot(task: Task, promise: Promise<void>): Promise<void>;
  }).holdExecutionSlot(task, promise);
const parkedOf = (executor: TaskExecutor, task: Task) =>
  (executor as unknown as { suspendedRecoveredExecutions: WeakMap<Task, unknown> })
    .suspendedRecoveredExecutions.get(task);

const sessionProjection = {
  status: "completed",
  termination_reason: null,
  termination_detail: null,
  review_state: "not_required",
  last_assistant_text: null,
  termination_event_id: null,
  updated_at: "2026-11-14T00:00:00.000Z",
  last_event_id: 3,
};

describe("card #1266 U5a 가: a fatal engine error reaches an execution parked by a retryable adoption rejection", () => {
  const agent = {
    id: "claude-roselin",
    name: "Roselin",
    backend: "claude",
    workspace_dir: "/tmp/claude-roselin",
  } as AgentProfile;

  function parkExecution() {
    const never = new Promise<never>(() => undefined);
    const frames = {
      [Symbol.asyncIterator]: () => ({ next: () => never }),
    };
    const dispatcher = {
      dispatch: vi.fn(),
      recoverFrames: vi.fn(() => frames),
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
    // 낡은 등록의 거절이라 다시 될 수 있는 거절이다. 러너와 프레임 통로를 붙인 채 멈춰 둔다.
    Object.assign(double.persistence, {
      enqueueRunningTransitionAndWaitForApplication: vi.fn(async () => ({
        eventId: 5,
        applied: false,
        rejectionReason: "already_terminal",
        canonicalSession: sessionProjection,
        canonicalExecutionRegistration: {
          registrationId: "registration-other",
          executionCommandId: "execute-other",
        },
      })),
    });
    const task = makeTask({ status: "initializing", profileId: agent.id });
    const adoption = executor.recoverRegisteredRunner(
      task,
      {
        config: { agent, sessionId: task.agentSessionId },
        lifecycle: {
          execution_command_id: "execute-old",
          execution_state: "running",
          terminal_error: null,
        },
      } as unknown as RunnerRegistration,
      "execute-old",
      "adopt",
    );
    return { executor, double, task, adoption, dispatcher };
  }

  it("ends the parked execution as an error with one termination event and releases the runner that holds its frame stream", async () => {
    const { executor, double, task, adoption, dispatcher } = parkExecution();
    await expect(adoption).rejects.toThrow();
    expect(parkedOf(executor, task)).toBeDefined();
    expect(task.status).toBe("initializing");
    expect(task.executionPromise).toBeUndefined();

    await expect(
      executor.terminateAfterFatalEngineError(task, "Persistent Claude Query is fatal"),
    ).resolves.toBe(true);

    expect(task.status).toBe("error");
    expect(task.terminationReason).toBe("error_aborted");
    expect(task.terminationEventRecorded).toBe(true);
    expect(double.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
    // 종료가 붙잡아 둔 러너를 놓아 프레임 통로도 함께 닫힌다.
    expect(task.runner).toBeUndefined();
    expect(dispatcher.close.mock.calls.length + dispatcher.detachHost.mock.calls.length)
      .toBeGreaterThan(0);
    expect(parkedOf(executor, task)).toBeUndefined();
  });

  it("does not terminate twice when a second fatal error arrives after the parked one", async () => {
    const { executor, double, task, adoption } = parkExecution();
    await expect(adoption).rejects.toThrow();
    await executor.terminateAfterFatalEngineError(task, "first");
    await expect(executor.terminateAfterFatalEngineError(task, "second")).resolves.toBe(false);
    expect(double.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
  });
});

describe("card #1266 U5a 나: an error between the source's done and the read waking up", () => {
  const iterable = (control: { finish?: () => void }): AsyncIterable<number> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<number>>((resolve) => {
        control.finish = () => resolve({ done: true, value: undefined as never });
      }),
    }),
  });

  it("turns the end of the read into the error instead of dropping it", async () => {
    const { executor } = makeExecutor();
    const task = makeTask();
    const control: { finish?: () => void } = {};
    const iterator = wrap(executor, task, iterable(control))[Symbol.asyncIterator]();

    const waiting = iterator.next();
    waiting.catch(() => undefined);
    await vi.waitFor(() => expect(signalOf(executor, task)?.waiters).toBe(1));
    control.finish!();
    // 약속은 풀렸지만 next()가 깨어나기 전이다. 이 틈에 치명 오류가 온다.
    await Promise.resolve();
    await expect(executor.terminateAfterFatalEngineError(task, "engine died in the gap"))
      .resolves.toBe(true);

    await expect(waiting).rejects.toThrow("engine died in the gap");
    expect(signalOf(executor, task)).toBeUndefined();
  });

  it("holds an error that arrives after the read ended and ends the active task once the execution settles", async () => {
    const { executor, double } = makeExecutor();
    const warn = vi.spyOn(logger, "warn");
    const task = makeTask();
    let settle!: () => void;
    const execution = new Promise<void>((resolve) => { settle = resolve; });
    holdSlot(executor, task, execution);

    for await (const _ of wrap(executor, task, (async function* () { yield 1; })())) {
      // 읽기를 끝까지 소비한다.
    }
    expect(signalOf(executor, task)).toBeUndefined();

    await expect(executor.terminateAfterFatalEngineError(task, "late fatal")).resolves.toBe(true);
    expect(task.status).toBe("running");
    expect(double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: task.agentSessionId }),
      expect.stringContaining("after the turn output ended"),
    );

    settle();
    await vi.waitFor(() => expect(task.status).toBe("error"));
    expect(task.terminationEventRecorded).toBe(true);
    expect(double.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("drops a held error when the execution already ended the task", async () => {
    const { executor, double } = makeExecutor();
    const task = makeTask();
    let settle!: () => void;
    holdSlot(executor, task, new Promise<void>((resolve) => { settle = resolve; }));
    for await (const _ of wrap(executor, task, (async function* () { yield 1; })())) {
      // 읽기를 끝까지 소비한다.
    }
    await executor.terminateAfterFatalEngineError(task, "late fatal");

    task.status = "completed";
    settle();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(task.status).toBe("completed");
    expect(double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
  });

  it("ends the next read on a held error when the task starts another turn", async () => {
    const { executor } = makeExecutor();
    const task = makeTask();
    holdSlot(executor, task, new Promise<void>(() => undefined));
    for await (const _ of wrap(executor, task, (async function* () { yield 1; })())) {
      // 읽기를 끝까지 소비한다.
    }
    await executor.terminateAfterFatalEngineError(task, "held across turns");

    const next = wrap(executor, task, (async function* () { yield 2; })())[Symbol.asyncIterator]();
    await expect(next.next()).rejects.toThrow("held across turns");
  });

  it("keeps declining while a turn is in flight and no read has ended (U4 behavior)", async () => {
    const { executor, double } = makeExecutor();
    const task = makeTask({ executionPromise: new Promise<void>(() => undefined) });

    await expect(executor.terminateAfterFatalEngineError(task, "x")).resolves.toBe(false);
    expect(task.status).toBe("running");
    expect(double.enqueueTerminalTransitionAndWaitForApplication).not.toHaveBeenCalled();
  });
});
