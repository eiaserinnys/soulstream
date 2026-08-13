import { describe, expect, it, vi } from "vitest";

import {
  RunnerRecoveryCoordinator,
  type RunnerRecoveryCoordinatorOptions,
} from "../../src/runner/runner_recovery_coordinator.js";
import { SessionDataHostError } from "../../src/control_plane/session_data_host_client.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { TaskHydrationFailedError } from "../../src/task/task_hydration_errors.js";
import type { Task } from "../../src/task/task_models.js";

const RECOVERY_NOW_MS = Date.parse("2026-08-11T00:00:30.000Z");

describe("RunnerRecoveryCoordinator exception matrix", () => {
  it("adopts a live registered runner before its first durable bootstrap event", async () => {
    const pending = {
      ...registration(),
      bootstrap: null,
      lifecycle: null,
    };
    const subject = makeSubject([pending]);

    await subject.coordinator.scanOnce();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      undefined,
      "adopt",
    );
    expect(subject.terminate).not.toHaveBeenCalled();
  });

  it("adopts a live runner whose execution is still running", async () => {
    const subject = makeSubject([registration({ lifecycleState: "running" })]);

    await subject.coordinator.scanOnce();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute-a",
      "adopt",
    );
    expect(subject.terminate).not.toHaveBeenCalled();
  });

  it("runner death while the server lives drains offline, marks error, and auto-resumes", async () => {
    const subject = makeSubject([registration({ pidAlive: false })]);

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.markRunnerFailureAndResume).toHaveBeenCalledOnce());

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute-a",
      "offline",
    );
    expect(subject.restartRegisteredRunner).toHaveBeenCalledOnce();
  });

  it("runner death while the server was absent follows the same startup scan path", async () => {
    const subject = makeSubject([registration({ pidAlive: false })]);

    await subject.coordinator.start();
    await vi.waitFor(() => expect(subject.restartRegisteredRunner).toHaveBeenCalledOnce());
    await subject.coordinator.stop();

    expect(subject.markRunnerFailureAndResume).toHaveBeenCalledWith(
      subject.task,
      "runner process exited before execution completed",
      expect.any(Function),
    );
  });

  it("terminates a live terminal runner before replaying its durable error offline", async () => {
    const subject = makeSubject([registration({
      lifecycleState: "failed",
      terminalError: { code: "execution_failed", message: "CLI exited 1" },
    })]);

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce());

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute-a",
      "offline",
    );
    expect(subject.terminate).toHaveBeenCalledWith(
      expect.anything(),
      { pid: 4123, startIdentity: "start-4123" },
    );
    expect(subject.terminate.mock.invocationCallOrder[0]).toBeLessThan(
      subject.recoverRegisteredRunner.mock.invocationCallOrder[0]!,
    );
    expect(subject.markRunnerFailureAndResume).not.toHaveBeenCalled();
  });

  it("does not terminate a live terminal registration already owned by this host", async () => {
    const subject = makeSubject([registration({ lifecycleState: "completed" })]);
    subject.task.runner = {} as NonNullable<Task["runner"]>;

    await subject.coordinator.scanOnce();

    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("replays a durable terminal state offline when the child exited before host recovery", async () => {
    const subject = makeSubject([registration({
      pidAlive: false,
      lifecycleState: "completed",
    })]);

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce());

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute-a",
      "offline",
    );
    expect(subject.markRunnerFailureAndResume).not.toHaveBeenCalled();
  });

  it("does not block server startup on a dead terminal runner waiting for upstream ACK", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const recoverRegisteredRunner = vi.fn(() => recovery);
    const subject = makeSubject([registration({
      pidAlive: false,
      lifecycleState: "completed",
    })], Date.now(), [], {
      taskExecutor: {
        recoverRegisteredRunner,
        restartRegisteredRunner: vi.fn(),
      },
    });

    await expect(Promise.race([
      subject.coordinator.scanOnce().then(() => "scanned"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])).resolves.toBe("scanned");
    expect(recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute-a",
      "offline",
    );
    finishRecovery();
    await subject.coordinator.stop();
  });

  it("does not await runner session garbage collection during startup", async () => {
    let finishCollection!: () => void;
    const collection = new Promise<{ removed: string[]; retained: [] }>((resolve) => {
      finishCollection = () => resolve({ removed: [], retained: [] });
    });
    const sessionGarbageCollector = { collect: vi.fn(() => collection) };
    const subject = makeSubject(
      [registration()],
      Date.parse("2026-08-11T00:00:30.000Z"),
      [],
      { sessionGarbageCollector },
    );

    await expect(Promise.race([
      subject.coordinator.start().then(() => "started"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])).resolves.toBe("started");
    expect(sessionGarbageCollector.collect).toHaveBeenCalledOnce();

    finishCollection();
    await subject.coordinator.stop();
  });

  it("serializes later recovery scans behind runner session garbage collection", async () => {
    let finishCollection!: () => void;
    const collection = new Promise<{ removed: string[]; retained: [] }>((resolve) => {
      finishCollection = () => resolve({ removed: [], retained: [] });
    });
    const sessionGarbageCollector = { collect: vi.fn(() => collection) };
    const subject = makeSubject(
      [registration()],
      Date.parse("2026-08-11T00:00:30.000Z"),
      [],
      { sessionGarbageCollector },
    );

    await subject.coordinator.scanOnce();
    const laterScan = subject.coordinator.scanOnce().then(() => "scanned");
    await expect(Promise.race([
      laterScan,
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ])).resolves.toBe("blocked");

    finishCollection();
    await expect(laterScan).resolves.toBe("scanned");
    await subject.coordinator.stop();
  });

  it("keeps terminal replay ahead of session garbage collection", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const sessionGarbageCollector = {
      collect: vi.fn(async () => ({ removed: [], retained: [] })),
    };
    const subject = makeSubject([registration({
      pidAlive: false,
      lifecycleState: "completed",
    })], Date.now(), [], {
      taskExecutor: {
        recoverRegisteredRunner: vi.fn(() => recovery),
        restartRegisteredRunner: vi.fn(),
      },
      sessionGarbageCollector,
    });

    await subject.coordinator.scanOnce();

    expect(sessionGarbageCollector.collect).not.toHaveBeenCalled();
    finishRecovery();
    await subject.coordinator.stop();
  });

  it("a live but stale progress lease is killed before offline drain and resume", async () => {
    const subject = makeSubject([registration({
      progressedAt: "2026-08-11T00:00:00.000Z",
    })], Date.parse("2026-08-11T00:03:00.000Z"));

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.restartRegisteredRunner).toHaveBeenCalledOnce());

    expect(subject.terminate).toHaveBeenCalledWith(
      expect.anything(),
      { pid: 4123, startIdentity: "start-4123" },
    );
    expect(subject.terminate.mock.invocationCallOrder[0]).toBeLessThan(
      subject.markReaped.mock.invocationCallOrder[0]!,
    );
    expect(subject.markRunnerFailureAndResume).toHaveBeenCalledWith(
      subject.task,
      "runner progress lease expired",
      expect.any(Function),
    );
  });

  it("replays offline when reap verification discovers a live terminal runner", async () => {
    const scanned = registration({
      progressedAt: "2026-08-11T00:00:00.000Z",
    });
    const terminal = registration({ lifecycleState: "completed" });
    const subject = makeSubject(
      [scanned],
      Date.parse("2026-08-11T00:03:00.000Z"),
      [],
      { hydrate: async () => terminal },
    );

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce());

    expect(subject.terminate).toHaveBeenCalledWith(
      expect.anything(),
      { pid: 4123, startIdentity: "start-4123" },
    );
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute-a",
      "offline",
    );
    expect(subject.markReaped).not.toHaveBeenCalled();
    expect(subject.restartRegisteredRunner).not.toHaveBeenCalled();
  });

  it("retries a previously reaped registration through offline drain and auto-resume", async () => {
    const subject = makeSubject([registration({
      pidAlive: false,
      lifecycleState: "reaped",
      terminalError: { code: "lease_expired", message: "lease expired before restart" },
    })]);

    await subject.coordinator.scanOnce();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      subject.task,
      expect.anything(),
      "execute-a",
      "offline",
    );
    expect(subject.markRunnerFailureAndResume).toHaveBeenCalledWith(
      subject.task,
      "lease expired before restart",
      expect.any(Function),
    );
    expect(subject.restartRegisteredRunner).toHaveBeenCalledOnce();
  });

  it("does not re-finalize the same closed registration across two process restarts", async () => {
    const closed = registration({
      pidAlive: false,
      lifecycleState: "closed",
    });
    const closedTailDrainer = { drain: vi.fn(async () => {}) };
    const sessionEnded = vi.fn();
    const delivery = vi.fn();
    const callerNotification = vi.fn();
    const recoverRegisteredRunner = vi.fn(async () => {
      sessionEnded();
      delivery();
      callerNotification();
    });
    const taskExecutor = {
      recoverRegisteredRunner,
      restartRegisteredRunner: vi.fn(),
    };
    const first = makeSubject([closed], Date.now(), [], { closedTailDrainer, taskExecutor });
    const second = makeSubject([closed], Date.now(), [], { closedTailDrainer, taskExecutor });

    await first.coordinator.scanOnce();
    await second.coordinator.scanOnce();

    expect(closedTailDrainer.drain).toHaveBeenCalledTimes(2);
    expect(first.hydrateRunnerRecoveryTask).not.toHaveBeenCalled();
    expect(second.hydrateRunnerRecoveryTask).not.toHaveBeenCalled();
    expect(first.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(second.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(first.markRunnerFailureAndResume).not.toHaveBeenCalled();
    expect(second.markRunnerFailureAndResume).not.toHaveBeenCalled();
    expect(sessionEnded).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
    expect(callerNotification).not.toHaveBeenCalled();
  });

  it("coalesces overlapping scan requests into one filesystem scan", async () => {
    let releaseScan!: () => void;
    const gate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const scan = vi.fn(async () => {
      await gate;
      return { registrations: [], errors: [] };
    });
    const subject = makeSubject([], Date.now(), [], { scan });

    const first = subject.coordinator.scanOnce();
    const second = subject.coordinator.scanOnce();
    expect(scan).toHaveBeenCalledOnce();
    releaseScan();
    await Promise.all([first, second]);
  });

  it("a reboot scan independently drains and resumes every dead registration", async () => {
    const first = registration({ sessionId: "session-a", pidAlive: false });
    const second = registration({ sessionId: "session-b", pidAlive: false });
    const subject = makeSubject([first, second]);

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.restartRegisteredRunner).toHaveBeenCalledTimes(2));

    expect(subject.hydrateRunnerRecoveryTask).toHaveBeenCalledWith("session-a");
    expect(subject.hydrateRunnerRecoveryTask).toHaveBeenCalledWith("session-b");
  });

  it("hydrates every admitted task before starting any recovery execution", async () => {
    const order: string[] = [];
    const first = registration({ sessionId: "session-a" });
    const second = registration({ sessionId: "session-b" });
    const tasks = new Map([
      ["session-a", task("session-a")],
      ["session-b", task("session-b")],
    ]);
    const hydrateRunnerRecoveryTask = vi.fn(async (sessionId: string) => {
      order.push(`hydrate:${sessionId}`);
      return tasks.get(sessionId) ?? null;
    });
    const recoverRegisteredRunner = vi.fn(async (recovered: Task) => {
      order.push(`recover:${recovered.agentSessionId}`);
    });
    const subject = makeSubject([first, second], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask,
        markRunnerFailureAndResume: vi.fn(async () => {}),
      },
      taskExecutor: {
        recoverRegisteredRunner,
        restartRegisteredRunner: vi.fn(),
      },
    });

    await subject.coordinator.scanOnce();

    expect(order).toEqual([
      "hydrate:session-a",
      "hydrate:session-b",
      "recover:session-a",
      "recover:session-b",
    ]);
  });

  it("caps the default hydration phase at ten seconds and defers unresolved work", async () => {
    vi.useFakeTimers();
    let finishHydration!: (value: Task) => void;
    const hydration = new Promise<Task>((resolve) => { finishHydration = resolve; });
    const subject = makeSubject([registration()], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(() => hydration),
        markRunnerFailureAndResume: vi.fn(async () => {}),
      },
    });
    let scanFinished = false;
    const scan = subject.coordinator.scanOnce().then(() => { scanFinished = true; });
    let beforeDeadline = false;
    let atDeadline = false;

    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(9_999);
      beforeDeadline = scanFinished;
      await vi.advanceTimersByTimeAsync(1);
      atDeadline = scanFinished;
    } finally {
      finishHydration(task("session-a"));
      await scan;
      vi.useRealTimers();
    }

    expect(beforeDeadline).toBe(false);
    expect(atDeadline).toBe(true);
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("starts at most four hydrations and leaves the queued remainder for a later scan", async () => {
    vi.useFakeTimers();
    const registrations = Array.from({ length: 6 }, (_, index) =>
      registration({ sessionId: `session-${index}` }));
    const hydrateRunnerRecoveryTask = vi.fn(async (sessionId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return task(sessionId);
    });
    const subject = makeSubject(registrations, RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask,
        markRunnerFailureAndResume: vi.fn(async () => {}),
      },
    });

    let scanFinished = false;
    const scan = subject.coordinator.scanOnce().then(() => { scanFinished = true; });
    let callsAtDeadline = 0;
    let finishedAtDeadline = false;
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      callsAtDeadline = hydrateRunnerRecoveryTask.mock.calls.length;
      finishedAtDeadline = scanFinished;
      await vi.advanceTimersByTimeAsync(120_000);
      await scan;
    } finally {
      vi.useRealTimers();
    }

    expect(finishedAtDeadline).toBe(true);
    expect(callsAtDeadline).toBe(4);
    expect(hydrateRunnerRecoveryTask).toHaveBeenCalledTimes(4);
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
  });

  it("reuses an in-flight hydration result on the next scan instead of duplicating the host call", async () => {
    vi.useFakeTimers();
    let finishHydration!: (value: Task) => void;
    const hydration = new Promise<Task>((resolve) => { finishHydration = resolve; });
    const hydrateRunnerRecoveryTask = vi.fn(() => hydration);
    const subject = makeSubject([registration()], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask,
        markRunnerFailureAndResume: vi.fn(async () => {}),
      },
    });
    let firstFinished = false;
    const firstScan = subject.coordinator.scanOnce().then(() => { firstFinished = true; });
    let finishedAtDeadline = false;
    let recoveredBeforeSecondScan = -1;

    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      finishedAtDeadline = firstFinished;
      finishHydration(task("session-a"));
      if (!firstFinished) await firstScan;
      await Promise.resolve();
      recoveredBeforeSecondScan = subject.recoverRegisteredRunner.mock.calls.length;
      if (finishedAtDeadline) await subject.coordinator.scanOnce();
    } finally {
      vi.useRealTimers();
    }

    expect(finishedAtDeadline).toBe(true);
    expect(recoveredBeforeSecondScan).toBe(0);
    expect(hydrateRunnerRecoveryTask).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce();
  });

  it("executes ready recoveries while a retryable host hydration failure stays deferred", async () => {
    const transient = new TaskHydrationFailedError(
      "session-a",
      new SessionDataHostError({
        operation: "get",
        retryable: true,
        message: "session-data host get failed",
      }),
    );
    const hydrateRunnerRecoveryTask = vi.fn(async (sessionId: string) => {
      if (sessionId === "session-a") throw transient;
      return task(sessionId);
    });
    const subject = makeSubject([
      registration({ sessionId: "session-a" }),
      registration({ sessionId: "session-b" }),
    ], RECOVERY_NOW_MS, [], {
      taskManager: {
        hydrateRunnerRecoveryTask,
        markRunnerFailureAndResume: vi.fn(async () => {}),
      },
    });

    await expect(subject.coordinator.scanOnce()).resolves.toBeUndefined();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "session-b" }),
      expect.anything(),
      "execute-a",
      "adopt",
    );
    expect(subject.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: transient,
        sessionId: "session-a",
        disposition: "adopt_running",
      }),
      "runner recovery hydration deferred",
    );
    expect(subject.logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "runner recovery action failed",
    );
  });

  it("periodically re-emits repeated hydration deferral without log flooding", async () => {
    let now = RECOVERY_NOW_MS;
    const transient = new TaskHydrationFailedError(
      "session-a",
      new SessionDataHostError({
        operation: "get",
        retryable: true,
        message: "session-data host get failed",
      }),
    );
    const hydrateRunnerRecoveryTask = vi.fn(async () => { throw transient; });
    const subject = makeSubject([registration()], now, [], {
      now: () => now,
      taskManager: {
        hydrateRunnerRecoveryTask,
        markRunnerFailureAndResume: vi.fn(async () => {}),
      },
    });

    await subject.coordinator.scanOnce();
    now += 15_000;
    await subject.coordinator.scanOnce();
    now += 14 * 60 * 1_000 + 45_000;
    await subject.coordinator.scanOnce();

    const deferredWarnings = subject.logger.warn.mock.calls.filter(
      ([, message]) => message === "runner recovery hydration deferred",
    );
    expect(deferredWarnings).toHaveLength(2);
    expect(deferredWarnings[1]).toEqual([
      expect.objectContaining({
        sessionId: "session-a",
        disposition: "adopt_running",
        suppressedSince: "2026-08-11T00:00:45.000Z",
        suppressedCount: 1,
      }),
      "runner recovery hydration deferred",
    ]);
  });

  it("disk or registration read failure is loud and does not invent recovery state", async () => {
    const error = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    const subject = makeSubject([], Date.now(), [{ directory: "/runner/a", error }]);

    await subject.coordinator.scanOnce();

    expect(subject.logger.error).toHaveBeenCalledWith(
      { directory: "/runner/a", err: error },
      "runner registration is unreadable",
    );
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(subject.markRunnerFailureAndResume).not.toHaveBeenCalled();
  });

  it("logs an unreadable registration once until its error fingerprint changes", async () => {
    let failure = {
      directory: "/runner/a",
      error: new Error("internalMcpUrl is required"),
      sessionId: "session-a",
    };
    const scan = vi.fn(async () => ({ registrations: [], errors: [failure] }));
    const quarantineFailure = vi.fn(async () => ({
      status: "retained" as const,
      reason: "runner_alive" as const,
    }));
    const subject = makeSubject([], Date.now(), [], { scan, quarantineFailure });

    await subject.coordinator.scanOnce();
    await subject.coordinator.scanOnce();
    failure = { ...failure, error: new Error("runner config JSON is damaged") };
    await subject.coordinator.scanOnce();

    expect(quarantineFailure).toHaveBeenCalledTimes(3);
    expect(subject.logger.error).toHaveBeenCalledTimes(2);
    expect(subject.logger.error).toHaveBeenNthCalledWith(
      1,
      failureContext("internalMcpUrl is required"),
      "runner registration is unreadable",
    );
    expect(subject.logger.error).toHaveBeenNthCalledWith(
      2,
      failureContext("runner config JSON is damaged"),
      "runner registration is unreadable",
    );
  });

  it("periodically re-emits a repeated recovery failure until its fingerprint changes", async () => {
    let now = Date.parse("2026-08-14T00:00:00.000Z");
    let failure = Object.assign(
      new Error("runner bootstrap record required before event append"),
      { code: "SQLITE_CORRUPT" },
    );
    const drain = vi.fn(async () => { throw failure; });
    const current = registration({ pidAlive: false, lifecycleState: "closed" });
    const subject = makeSubject([current], now, [], {
      closedTailDrainer: { drain },
      now: () => now,
    });

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    now += 15_000;
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    now += 14 * 60 * 1_000 + 45_000;
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();
    failure = Object.assign(new Error("runner host checkpoint is corrupt"), {
      code: "SQLITE_CORRUPT",
    });
    now += 1;
    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(drain).toHaveBeenCalledTimes(4);
    expect(subject.logger.error).toHaveBeenCalledTimes(3);
    expect(subject.logger.error).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        err: expect.objectContaining({
          message: "runner bootstrap record required before event append",
        }),
        sessionId: "session-a",
        disposition: "closed",
      }),
      "runner recovery action failed",
    );
    expect(subject.logger.error).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        suppressedSince: "2026-08-14T00:00:15.000Z",
        suppressedCount: 1,
        sessionId: "session-a",
        disposition: "closed",
      }),
      "runner recovery action failed",
    );
    expect(subject.logger.error).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        err: expect.objectContaining({ message: "runner host checkpoint is corrupt" }),
        sessionId: "session-a",
        disposition: "closed",
      }),
      "runner recovery action failed",
    );
  });

  it("isolates a disk-full reap write without killing the scan or resuming invented state", async () => {
    const error = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    const subject = makeSubject([registration({ pidAlive: false })], Date.now(), [], {
      markReaped: vi.fn().mockRejectedValue(error),
    });

    await expect(subject.coordinator.scanOnce()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(subject.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: error,
        sessionId: "session-a",
        disposition: "reap_dead",
      }),
      "runner recovery action failed",
    ));

    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.markRunnerFailureAndResume).not.toHaveBeenCalled();
  });

  it("waits for an active recovery before stop returns", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const subject = makeSubject([registration({
      pidAlive: false,
      lifecycleState: "completed",
    })], Date.now(), [], {
      taskExecutor: {
        recoverRegisteredRunner: vi.fn(() => recovery),
        restartRegisteredRunner: vi.fn(),
      },
    });
    await subject.coordinator.scanOnce();

    let stopped = false;
    const stopping = subject.coordinator.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishRecovery();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("exposes a reconciliation barrier without stopping future scans", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const subject = makeSubject([registration({
      pidAlive: false,
      lifecycleState: "completed",
    })], Date.now(), [], {
      taskExecutor: {
        recoverRegisteredRunner: vi.fn(() => recovery),
        restartRegisteredRunner: vi.fn(),
      },
    });
    await subject.coordinator.scanOnce();

    let settled = false;
    const waiting = subject.coordinator.waitForSettled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishRecovery();
    await waiting;
    expect(settled).toBe(true);
    await expect(subject.coordinator.scanOnce()).resolves.toBeUndefined();
  });
});

describe("RunnerRecoveryCoordinator GC cadence", () => {
  it("runs session state GC at startup and then at most hourly", async () => {
    let now = Date.parse("2026-08-11T00:00:00.000Z");
    const current = registration();
    const sessionGarbageCollector = {
      collect: vi.fn(async () => ({ removed: [], retained: [] })),
    };
    const subject = makeSubject([current], now, [], {
      now: () => now,
      leaseTimeoutMs: 2 * 60 * 60 * 1_000,
      sessionGarbageCollector,
    });

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(sessionGarbageCollector.collect).toHaveBeenCalledOnce());
    await subject.coordinator.scanOnce();
    expect(sessionGarbageCollector.collect).toHaveBeenCalledOnce();

    now += 60 * 60 * 1_000;
    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(sessionGarbageCollector.collect).toHaveBeenCalledTimes(2));
  });

  it("does not repeat durable release inspection when the lightweight candidate fingerprint is unchanged", async () => {
    const current = registration({ pidAlive: false, lifecycleState: "completed" });
    current.databaseMtimeMs = 1;
    const releaseGarbageCollector = { collect: vi.fn(async () => ({ removed: [], retained: [] })) };
    const subject = makeSubject([current], Date.now(), [], { releaseGarbageCollector });

    await subject.coordinator.scanOnce();
    await subject.coordinator.scanOnce();

    expect(releaseGarbageCollector.collect).toHaveBeenCalledOnce();

    current.databaseMtimeMs = 2;
    await subject.coordinator.scanOnce();

    expect(releaseGarbageCollector.collect).toHaveBeenCalledTimes(2);

    current.hostDatabaseWalMtimeMs = 3;
    await subject.coordinator.scanOnce();

    expect(releaseGarbageCollector.collect).toHaveBeenCalledTimes(3);
  });

  it("does not run durable release inspection for database churn on an active runner", async () => {
    const current = registration({ pidAlive: true, lifecycleState: "running" });
    current.databaseMtimeMs = 1;
    const releaseGarbageCollector = { collect: vi.fn(async () => ({ removed: [], retained: [] })) };
    const subject = makeSubject([current], Date.now(), [], { releaseGarbageCollector });

    await subject.coordinator.scanOnce();
    current.databaseMtimeMs = 2;
    await subject.coordinator.scanOnce();

    expect(releaseGarbageCollector.collect).toHaveBeenCalledOnce();
  });
});

function makeSubject(
  registrations: RunnerRegistration[],
  now = Date.parse("2026-08-11T00:00:30.000Z"),
  errors: Array<{ directory: string; error: Error }> = [],
  overrides: Partial<RunnerRecoveryCoordinatorOptions> = {},
) {
  const tasks = new Map<string, Task>();
  for (const item of registrations) {
    tasks.set(item.config.sessionId, task(item.config.sessionId));
  }
  const fallbackTask = task("session-a");
  const hydrateRunnerRecoveryTask = vi.fn(async (sessionId: string) =>
    tasks.get(sessionId) ?? fallbackTask);
  const recoverRegisteredRunner = vi.fn(async () => {});
  const restartRegisteredRunner = vi.fn();
  const markRunnerFailureAndResume = vi.fn(async (
    recovered: Task,
    _message: string,
    resume: (task: Task) => void,
  ) => resume(recovered));
  const terminate = vi.fn(async () => {});
  const markReaped = vi.fn(async () => {});
  const logger = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const options: RunnerRecoveryCoordinatorOptions = {
    stateDirectory: "/runner",
    leaseTimeoutMs: 120_000,
    scanIntervalMs: 15_000,
    taskManager: { hydrateRunnerRecoveryTask, markRunnerFailureAndResume },
    taskExecutor: { recoverRegisteredRunner, restartRegisteredRunner },
    closedTailDrainer: { drain: vi.fn(async () => {}) },
    logger,
    spawner: { terminate },
    scan: async () => structuredClone({ registrations, errors }),
    hydrate: async (registration) => registration,
    now: () => now,
    markReaped,
    ...overrides,
  };
  return {
    coordinator: new RunnerRecoveryCoordinator(options),
    task: tasks.get("session-a") ?? fallbackTask,
    hydrateRunnerRecoveryTask,
    recoverRegisteredRunner,
    restartRegisteredRunner,
    markRunnerFailureAndResume,
    markReaped,
    terminate,
    logger,
  };
}

function failureContext(message: string) {
  return expect.objectContaining({
    directory: "/runner/a",
    sessionId: "session-a",
    err: expect.objectContaining({ message }),
  });
}

function registration(options: {
  sessionId?: string;
  pidAlive?: boolean;
  lifecycleState?: "running" | "completed" | "failed" | "reaped" | "closed";
  progressedAt?: string;
  terminalError?: { code: string; message: string } | null;
} = {}): RunnerRegistration {
  const sessionId = options.sessionId ?? "session-a";
  return {
    config: {
      schemaVersion: 1,
      sessionId,
      backend: "codex",
      agent: {
        id: "agent-a",
        name: "Agent A",
        backend: "codex",
        workspace_dir: "/workspace/a",
      },
      paths: {
        sessionDirectory: `/runner/${sessionId}`,
        databasePath: `/runner/${sessionId}/runner.sqlite`,
        socketPath: `/runner/${sessionId}/runner.sock`,
        pidPath: `/runner/${sessionId}/runner.pid`,
        lockPath: `/runner/${sessionId}/runner.lock`,
        configPath: `/runner/${sessionId}/runner-config.json`,
      },
      codeSha: "sha-a",
      snapshotPath: "/release/sha-a/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 1_800_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    pid: 4123,
    pidStartIdentity: "start-4123",
    pidAlive: options.pidAlive ?? true,
    registeredAtMs: Date.parse("2026-08-11T00:00:00.000Z"),
    bootstrap: {
      stream_id: `stream-${sessionId}`,
      source_seq: 1,
      session_id: sessionId,
      event_type: "runner_bootstrap",
      payload: {
        schema_version: 1,
        backend_session_id: `backend-${sessionId}`,
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "sha-a",
        snapshot_path: "/release/sha-a/soul-server-ts",
      },
      searchable_text: null,
      created_at: "2026-08-11T00:00:00.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
      payload_hash: "0".repeat(64),
    },
    lifecycle: {
      session_id: sessionId,
      runner_pid: 4123,
      execution_command_id: "execute-a",
      execution_state: options.lifecycleState ?? "running",
      progress_seq: 3,
      progress_at: options.progressedAt ?? "2026-08-11T00:00:20.000Z",
      liveness_at: options.progressedAt ?? "2026-08-11T00:00:20.000Z",
      in_flight_tools: [],
      terminal_error: options.terminalError ?? null,
    },
  };
}

function task(sessionId: string): Task {
  return {
    agentSessionId: sessionId,
    prompt: "continue",
    status: "running",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}
