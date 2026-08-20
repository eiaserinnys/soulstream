import { describe, expect, it, vi } from "vitest";

import {
  RunnerRecoveryCoordinator,
  type RunnerRecoveryCoordinatorOptions,
} from "../../src/runner/runner_recovery_coordinator.js";
import { SessionDataHostError } from "../../src/control_plane/session_data_host_client.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { TaskHydrationFailedError } from "../../src/task/task_hydration_errors.js";
import { ExecutionOwnershipBackoff } from "../../src/task/execution_ownership_backoff.js";
import type { Task } from "../../src/task/task_models.js";

const RECOVERY_NOW_MS = Date.parse("2026-08-11T00:00:30.000Z");

describe("RunnerRecoveryCoordinator exception matrix", () => {
  it("isolates a malformed registration classification and recovers later sessions", async () => {
    const malformed = registration({
      sessionId: "session-malformed",
      lifecycleState: "running",
      progressedAt: "not-a-timestamp",
    });
    const healthy = registration({ sessionId: "session-healthy", lifecycleState: "running" });
    const subject = makeSubject([malformed, healthy]);

    await expect(subject.coordinator.scanOnce()).resolves.toBeUndefined();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "session-healthy" }),
      expect.anything(),
      "execute-a",
      "adopt",
    );
    expect(subject.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: expect.stringContaining("timestamp invalid") }),
        sessionId: "session-malformed",
      }),
      "runner recovery classification failed",
    );
  });

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

  it("uses two stable production scans before backfilling an owner-null running session", async () => {
    let now = RECOVERY_NOW_MS;
    const recoveredTask = task("session-a");
    recoveredTask.hydratedFromDb = true;
    const reconcileExecutionOwnershipObservations = vi.fn(async (
      _task: Task,
      input: { probeOnly: boolean },
    ) => !input.probeOnly);
    const subject = makeSubject([registration()], now, [], {
      now: () => now,
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => recoveredTask),
        markRunnerFailureAndResume: vi.fn(async () => {}),
        projectClosedRunner: vi.fn(async () => true),
        reconcileExecutionOwnershipObservations,
      },
    });

    await subject.coordinator.scanOnce();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    now += 15_000;
    await subject.coordinator.scanOnce();

    expect(reconcileExecutionOwnershipObservations).toHaveBeenCalledTimes(2);
    expect(reconcileExecutionOwnershipObservations.mock.calls[1]?.[1]).toMatchObject({
      first: {
        manifestId: "sha-a",
        registrationId: "registration-a",
        pid: 4123,
        startIdentity: "start-4123",
        executionCommandId: "execute-a",
      },
      second: {
        manifestId: "sha-a",
        registrationId: "registration-a",
        pid: 4123,
        startIdentity: "start-4123",
        executionCommandId: "execute-a",
      },
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      probeOnly: false,
    });
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce();
  });

  it("interrupts instead of adopting when one owner identity field changes between scans", async () => {
    let now = RECOVERY_NOW_MS;
    const current = registration();
    const recoveredTask = task("session-a");
    recoveredTask.hydratedFromDb = true;
    const reconcileExecutionOwnershipObservations = vi.fn(async (
      candidate: Task,
      input: { probeOnly: boolean },
    ) => {
      if (input.probeOnly) return false;
      candidate.status = "interrupted";
      return false;
    });
    const subject = makeSubject([current], now, [], {
      now: () => now,
      taskManager: {
        hydrateRunnerRecoveryTask: vi.fn(async () => recoveredTask),
        markRunnerFailureAndResume: vi.fn(async () => {}),
        projectClosedRunner: vi.fn(async () => true),
        reconcileExecutionOwnershipObservations,
      },
    });

    await subject.coordinator.scanOnce();
    current.registrationId = "registration-b";
    now += 15_000;
    await subject.coordinator.scanOnce();

    expect(reconcileExecutionOwnershipObservations.mock.calls[1]?.[1]).toMatchObject({
      first: { registrationId: "registration-a" },
      second: { registrationId: "registration-b" },
      probeOnly: false,
    });
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(subject.terminate).toHaveBeenCalledOnce();
  });

  it("converges e5d01ad7 and c643e966 owner-null inventory rows without registrations", async () => {
    let now = RECOVERY_NOW_MS;
    const sessions = ["e5d01ad7-regression", "c643e966-regression"];
    const tasks = new Map(sessions.map((sessionId) => {
      const candidate = task(sessionId);
      candidate.hydratedFromDb = true;
      return [sessionId, candidate] as const;
    }));
    const reconcileExecutionOwnershipObservations = vi.fn(async (
      candidate: Task,
      input: { probeOnly: boolean },
    ) => {
      if (!input.probeOnly) candidate.status = "interrupted";
      return false;
    });
    const subject = makeSubject([], now, [], {
      now: () => now,
      taskManager: {
        listOwnerNullRunningInventory: vi.fn(async () => sessions.map((sessionId) => ({
          session_id: sessionId,
          node_id: "node-a",
          updated_at: new Date("2026-08-11T00:00:00.000Z"),
        }))),
        hydrateRunnerRecoveryTask: vi.fn(async (sessionId) => tasks.get(sessionId) ?? null),
        markRunnerFailureAndResume: vi.fn(async () => {}),
        projectClosedRunner: vi.fn(async () => true),
        reconcileExecutionOwnershipObservations,
      },
    });

    await subject.coordinator.scanOnce();
    now += 15_000;
    await subject.coordinator.scanOnce();

    expect(reconcileExecutionOwnershipObservations).toHaveBeenCalledTimes(4);
    for (const sessionId of sessions) {
      expect(tasks.get(sessionId)?.status).toBe("interrupted");
    }
    for (const [, input] of reconcileExecutionOwnershipObservations.mock.calls) {
      expect(input).toMatchObject({
        first: {
          manifestId: null,
          registrationId: null,
          pid: null,
          startIdentity: null,
          executionCommandId: null,
        },
        second: {
          manifestId: null,
          registrationId: null,
          pid: null,
          startIdentity: null,
          executionCommandId: null,
        },
        evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
  });

  it("isolates owner-null inventory read failure from registration recovery", async () => {
    const current = registration({ lifecycleState: "running" });
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskManager: {
        listOwnerNullRunningInventory: vi.fn(async () => {
          throw new Error("orchestrator unavailable");
        }),
      },
    });

    await subject.coordinator.scanOnce();

    expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce();
    expect(subject.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "node-a" }),
      "owner-null running inventory read failed",
    );
  });

  it("reaps and restarts when adoption loses a runner before its socket becomes available", async () => {
    const socketError = runnerSocketMissingError();
    const failedRunner = failedRecoveryRunner();
    const restartRegisteredRunner = vi.fn();
    const recoverRegisteredRunner = vi.fn((recovered: Task, _config, _commandId, mode) => {
      if (mode === "offline") return Promise.resolve();
      const failure = Promise.reject(socketError);
      recovered.runner = failedRunner.runner;
      recovered.executionPromise = failure;
      return failure;
    });
    const current = registration({ lifecycleState: "running" });
    const refreshRegistration = vi.fn(async () => ({ ...current, pidAlive: false }));
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskExecutor: {
        recoverRegisteredRunner,
        restartRegisteredRunner,
      },
      refreshRegistration,
    });

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(refreshRegistration).toHaveBeenCalledOnce());
    expect(subject.logger.error.mock.calls).toEqual([]);
    await vi.waitFor(() => expect(subject.markReaped).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(recoverRegisteredRunner).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(subject.markRunnerFailureAndResume).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(restartRegisteredRunner).toHaveBeenCalledOnce());

    expect(refreshRegistration).toHaveBeenCalledOnce();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.invalidateRegistration).toHaveBeenCalledWith(
      current.config.paths,
      "registration-a",
    );
    expect(subject.invalidateRegistration.mock.invocationCallOrder[0]).toBeLessThan(
      restartRegisteredRunner.mock.invocationCallOrder[0]!,
    );
    expect(recoverRegisteredRunner).toHaveBeenNthCalledWith(
      2,
      subject.task,
      expect.anything(),
      "execute-a",
      "offline",
    );
    expect(subject.markReaped.mock.invocationCallOrder[0]).toBeLessThan(
      recoverRegisteredRunner.mock.invocationCallOrder[1]!,
    );
    expect(failedRunner.detachHost).toHaveBeenCalledOnce();
  });

  it("identity-fences a live running registration whose socket disappeared before restart", async () => {
    const socketError = runnerSocketMissingError();
    const failedRunner = failedRecoveryRunner();
    const restartRegisteredRunner = vi.fn();
    const recoverRegisteredRunner = vi.fn((recovered: Task, _config, _commandId, mode) => {
      if (mode === "offline") return Promise.resolve();
      const failure = Promise.reject(socketError);
      recovered.runner = failedRunner.runner;
      recovered.executionPromise = failure;
      return failure;
    });
    const current = registration({ lifecycleState: "running" });
    const refreshRegistration = vi.fn(async () => current);
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskExecutor: {
        recoverRegisteredRunner,
        restartRegisteredRunner,
      },
      refreshRegistration,
    });

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(refreshRegistration).toHaveBeenCalledOnce());
    expect(subject.logger.error.mock.calls).toEqual([]);
    await vi.waitFor(() => expect(subject.markReaped).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(recoverRegisteredRunner).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(subject.markRunnerFailureAndResume).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(restartRegisteredRunner).toHaveBeenCalledOnce());

    expect(subject.terminate).toHaveBeenCalledWith(
      expect.anything(),
      { pid: 4123, startIdentity: "start-4123" },
    );
    expect(subject.terminate.mock.invocationCallOrder[0]).toBeLessThan(
      subject.markReaped.mock.invocationCallOrder[0]!,
    );
    expect(subject.markReaped.mock.invocationCallOrder[0]).toBeLessThan(
      recoverRegisteredRunner.mock.invocationCallOrder[1]!,
    );
  });

  it("does not kill a live prebootstrap runner for a transient missing socket", async () => {
    const socketError = runnerSocketMissingError();
    const failedRunner = failedRecoveryRunner();
    const restartRegisteredRunner = vi.fn();
    const recoverRegisteredRunner = vi.fn((recovered: Task) => {
      const failure = Promise.reject(socketError);
      recovered.runner = failedRunner.runner;
      recovered.executionPromise = failure;
      return failure;
    });
    const pending = {
      ...registration(),
      bootstrap: null,
      lifecycle: null,
    };
    const refreshRegistration = vi.fn(async () => pending);
    const subject = makeSubject([pending], RECOVERY_NOW_MS, [], {
      taskExecutor: {
        recoverRegisteredRunner,
        restartRegisteredRunner,
      },
      refreshRegistration,
    });

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(refreshRegistration).toHaveBeenCalledOnce());

    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.markReaped).not.toHaveBeenCalled();
    expect(restartRegisteredRunner).not.toHaveBeenCalled();
  });

  it("does not replace a runner after a newer execution takes task ownership", async () => {
    const failedRunner = failedRecoveryRunner();
    const newerRunner = failedRecoveryRunner();
    let rejectAdoption!: (error: unknown) => void;
    const adoptionFailure = new Promise<void>((_resolve, reject) => {
      rejectAdoption = reject;
    });
    const recoverRegisteredRunner = vi.fn((recovered: Task) => {
      recovered.runner = failedRunner.runner;
      recovered.executionPromise = adoptionFailure;
      return adoptionFailure;
    });
    const current = registration({ lifecycleState: "running" });
    const refreshRegistration = vi.fn(async () => current);
    const restartRegisteredRunner = vi.fn();
    const subject = makeSubject([current], RECOVERY_NOW_MS, [], {
      taskExecutor: { recoverRegisteredRunner, restartRegisteredRunner },
      refreshRegistration,
    });

    await subject.coordinator.scanOnce();
    const newerExecution = Promise.resolve();
    subject.task.runner = newerRunner.runner;
    subject.task.executionPromise = newerExecution;
    rejectAdoption(runnerSocketMissingError());
    await subject.coordinator.waitForSettled();

    expect(subject.task.runner).toBe(newerRunner.runner);
    expect(subject.task.executionPromise).toBe(newerExecution);
    expect(refreshRegistration).not.toHaveBeenCalled();
    expect(failedRunner.detachHost).not.toHaveBeenCalled();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.markReaped).not.toHaveBeenCalled();
    expect(restartRegisteredRunner).not.toHaveBeenCalled();
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

  it("startup terminates a live failed runner before replaying its durable error offline", async () => {
    const subject = makeSubject([registration({
      lifecycleState: "failed",
      terminalError: { code: "execution_failed", message: "CLI exited 1" },
    })]);

    await subject.coordinator.start();
    await vi.waitFor(() => expect(subject.recoverRegisteredRunner).toHaveBeenCalledOnce());
    await subject.coordinator.stop();

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

  it("terminates a live completed runner and replays its durable tail offline", async () => {
    const subject = makeSubject([registration({ lifecycleState: "completed" })]);

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
  });

  it("does not block recovery scans while a live completed runner drains offline", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const recoverRegisteredRunner = vi.fn(() => recovery);
    const subject = makeSubject([registration({ lifecycleState: "completed" })], Date.now(), [], {
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
    expect(subject.terminate).toHaveBeenCalledOnce();

    finishRecovery();
    await subject.coordinator.stop();
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

  it("terminates and drains offline when reap verification discovers a live completed runner", async () => {
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

    expect(subject.terminate).toHaveBeenCalledOnce();
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
    await subject.coordinator.waitForSettled();

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
    expect(subject.task).toMatchObject({
      runnerTerminalFact: "reaped",
      recoveredExecutionOwnership: {
        manifestId: "sha-a",
        registrationId: "registration-a",
        pid: 4123,
        startIdentity: "start-4123",
      },
    });
    expect(subject.restartRegisteredRunner).toHaveBeenCalledOnce();
  });

  it("conservatively drains a closed registration across restarts when tail state is missing", async () => {
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
    await first.coordinator.waitForSettled();
    await second.coordinator.waitForSettled();

    expect(closedTailDrainer.drain).toHaveBeenCalledTimes(2);
    expect(first.hydrateRunnerRecoveryTask).toHaveBeenCalledOnce();
    expect(second.hydrateRunnerRecoveryTask).toHaveBeenCalledOnce();
    expect(first.projectClosedRunner).toHaveBeenCalledOnce();
    expect(second.projectClosedRunner).toHaveBeenCalledOnce();
    expect(first.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(second.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(first.markRunnerFailureAndResume).not.toHaveBeenCalled();
    expect(second.markRunnerFailureAndResume).not.toHaveBeenCalled();
    expect(sessionEnded).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
    expect(callerNotification).not.toHaveBeenCalled();
  });

  it("reclassifies a closed admission after hydration instead of terminating its replacement", async () => {
    const admittedClosed = registration({ pidAlive: false, lifecycleState: "closed" });
    const replacement = registration({ pidAlive: true, lifecycleState: "running" });
    const subject = makeSubject([admittedClosed], Date.now(), [], {
      hydrate: vi.fn(async () => replacement),
    });
    subject.task.runner = { dispatcher: {} as never };

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.projectClosedRunner).not.toHaveBeenCalled();
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(subject.task.runner).toBeDefined();
  });

  it.each([
    ["running", false],
    ["running", true],
    ["completed", false],
    ["completed", true],
    ["error", false],
    ["error", true],
    ["interrupted", false],
    ["interrupted", true],
  ] as const)(
    "projects a closed runner for central %s with tail=%s",
    async (centralStatus, tailRequiresDrain) => {
      const closed = registration({ pidAlive: false, lifecycleState: "closed" });
      closed.closedTailState = tailRequiresDrain
        ? {
            status: "requires_drain",
            streamId: "stream-session-a",
            sessionId: "session-a",
            latestDurableSourceSeq: 3,
            acknowledgedThrough: 2,
          }
        : {
            status: "fully_acknowledged",
            streamId: "stream-session-a",
            sessionId: "session-a",
            latestDurableSourceSeq: 2,
            acknowledgedThrough: 2,
          };
      const closedTailDrainer = { drain: vi.fn(async () => {}) };
      const subject = makeSubject([closed], Date.now(), [], { closedTailDrainer });
      subject.task.status = centralStatus;

      await subject.coordinator.scanOnce();
      await subject.coordinator.waitForSettled();

      expect(closedTailDrainer.drain).toHaveBeenCalledTimes(
        tailRequiresDrain ? 1 : 0,
      );
      expect(subject.projectClosedRunner).toHaveBeenCalledWith(
        subject.task,
        "runner lifecycle closed during startup recovery",
      );
    },
  );

  it("does not open a fully acknowledged closed registration across repeated scans", async () => {
    const closed = registration({ pidAlive: false, lifecycleState: "closed" });
    closed.closedTailState = {
      status: "fully_acknowledged",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 2,
      acknowledgedThrough: 2,
    };
    const closedTailDrainer = { drain: vi.fn(async () => {}) };
    const subject = makeSubject([closed], Date.now(), [], { closedTailDrainer });

    await subject.coordinator.scanOnce();
    await subject.coordinator.scanOnce();

    expect(closedTailDrainer.drain).not.toHaveBeenCalled();
  });

  it("never skips a closed registration with an unacknowledged durable tail", async () => {
    const closed = registration({ pidAlive: false, lifecycleState: "closed" });
    closed.closedTailState = {
      status: "requires_drain",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 3,
      acknowledgedThrough: 2,
    };
    const closedTailDrainer = { drain: vi.fn(async () => {}) };
    const subject = makeSubject([closed], Date.now(), [], { closedTailDrainer });

    await subject.coordinator.scanOnce();

    expect(closedTailDrainer.drain).toHaveBeenCalledOnce();
  });

  it("rechecks a closed registration when a new event advances its durable head", async () => {
    const closed = registration({ pidAlive: false, lifecycleState: "closed" });
    closed.closedTailState = {
      status: "fully_acknowledged",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 2,
      acknowledgedThrough: 2,
    };
    const closedTailDrainer = { drain: vi.fn(async () => {}) };
    const subject = makeSubject([closed], Date.now(), [], { closedTailDrainer });

    await subject.coordinator.scanOnce();
    closed.closedTailState = {
      status: "requires_drain",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 3,
      acknowledgedThrough: 2,
    };
    await subject.coordinator.scanOnce();

    expect(closedTailDrainer.drain).toHaveBeenCalledOnce();
  });

  it("conservatively drains when the closed-tail fingerprint cannot be trusted", async () => {
    const closed = registration({ pidAlive: false, lifecycleState: "closed" });
    closed.closedTailState = {
      status: "unknown",
      reason: "runner host checkpoint hash mismatch",
    };
    const closedTailDrainer = { drain: vi.fn(async () => {}) };
    const subject = makeSubject([closed], Date.now(), [], { closedTailDrainer });

    await subject.coordinator.scanOnce();

    expect(closedTailDrainer.drain).toHaveBeenCalledOnce();
  });

  it("logs recovery scan duration and closed-tail decisions at info", async () => {
    const closed = registration({ pidAlive: false, lifecycleState: "closed" });
    closed.closedTailState = {
      status: "fully_acknowledged",
      streamId: "stream-session-a",
      sessionId: "session-a",
      latestDurableSourceSeq: 2,
      acknowledgedThrough: 2,
    };
    const monotonicNow = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(112.5);
    const subject = makeSubject([closed], Date.now(), [], { monotonicNow });

    await subject.coordinator.scanOnce();

    expect(subject.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 12.5,
        terminalRegistrations: 1,
        closedRegistrations: 1,
        closedTailDrains: 0,
        closedTailSkips: 1,
      }),
      "runner recovery scan completed",
    );
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
    let callsOnSecondScan = 0;
    let recoveriesOnSecondScan = 0;
    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      callsAtDeadline = hydrateRunnerRecoveryTask.mock.calls.length;
      finishedAtDeadline = scanFinished;
      await vi.advanceTimersByTimeAsync(120_000);
      await scan;
      const secondScan = subject.coordinator.scanOnce();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      await secondScan;
      callsOnSecondScan = hydrateRunnerRecoveryTask.mock.calls.length;
      recoveriesOnSecondScan = subject.recoverRegisteredRunner.mock.calls.length;
    } finally {
      vi.useRealTimers();
    }

    expect(finishedAtDeadline).toBe(true);
    expect(callsAtDeadline).toBe(4);
    expect(callsOnSecondScan).toBe(6);
    expect(recoveriesOnSecondScan).toBe(4);
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
      leaseTimeoutMs: 2 * 60 * 60 * 1_000,
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

describe("RunnerRecoveryCoordinator execution ownership backoff", () => {
  /**
   * 260820 incident: the scan re-attempted a session whose ownership was
   * wedged on its own 14s cadence, ignoring the +60s the rejection asked for.
   */
  it("skips a session until the ownership backoff it was given expires", async () => {
    let nowMs = RECOVERY_NOW_MS;
    const backoff = new ExecutionOwnershipBackoff({
      logger: { warn: vi.fn(), error: vi.fn() },
      now: () => nowMs,
    });
    const subject = makeSubject(
      [registration({ lifecycleState: "running" })],
      RECOVERY_NOW_MS,
      [],
      { ownershipBackoff: backoff, now: () => nowMs },
    );

    await subject.coordinator.scanOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledTimes(1);

    backoff.observeConflict("session-a", new Date(nowMs + 60_000).toISOString());

    nowMs += 14_000;
    await subject.coordinator.scanOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledTimes(1);

    nowMs += 50_000;
    await subject.coordinator.scanOnce();
    expect(subject.recoverRegisteredRunner).toHaveBeenCalledTimes(2);
  });

  /**
   * The backoff exists to stop a session from re-contending for ownership it
   * keeps losing. Reaping a runner that has since died contends for nothing,
   * and holding it back would strand the session for the whole backoff.
   */
  it("still reaps a dead runner while its ownership backoff is in force", async () => {
    let nowMs = RECOVERY_NOW_MS;
    const backoff = new ExecutionOwnershipBackoff({
      logger: { warn: vi.fn(), error: vi.fn() },
      now: () => nowMs,
    });
    backoff.observeConflict("session-a", new Date(nowMs + 60_000).toISOString());
    const subject = makeSubject(
      [registration({ pidAlive: false })],
      RECOVERY_NOW_MS,
      [],
      { ownershipBackoff: backoff, now: () => nowMs },
    );

    await subject.coordinator.scanOnce();

    expect(subject.markReaped).toHaveBeenCalled();
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
  const projectClosedRunner = vi.fn(async () => true);
  const listOwnerNullRunningInventory = vi.fn(async () => []);
  const reconcileExecutionOwnershipObservations = vi.fn(async () => false);
  const terminate = vi.fn(async () => {});
  const invalidateRegistration = vi.fn(async () => {});
  const markReaped = vi.fn(async () => {});
  const logger = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const baseTaskManager = {
    hydrateRunnerRecoveryTask,
    markRunnerFailureAndResume,
    projectClosedRunner,
    listOwnerNullRunningInventory,
    reconcileExecutionOwnershipObservations,
  };
  const options: RunnerRecoveryCoordinatorOptions = {
    nodeId: "node-a",
    stateDirectory: "/runner",
    leaseTimeoutMs: 120_000,
    scanIntervalMs: 15_000,
    taskExecutor: { recoverRegisteredRunner, restartRegisteredRunner },
    closedTailDrainer: { drain: vi.fn(async () => {}) },
    logger,
    spawner: { terminate, invalidateRegistration },
    scan: async () => structuredClone({ registrations, errors }),
    hydrate: async (registration) => registration,
    now: () => now,
    markReaped,
    ...overrides,
    taskManager: {
      ...baseTaskManager,
      ...overrides.taskManager,
    },
  };
  return {
    coordinator: new RunnerRecoveryCoordinator(options),
    task: tasks.get("session-a") ?? fallbackTask,
    hydrateRunnerRecoveryTask,
    recoverRegisteredRunner,
    restartRegisteredRunner,
    markRunnerFailureAndResume,
    projectClosedRunner,
    markReaped,
    terminate,
    invalidateRegistration,
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

function runnerSocketMissingError(): Error {
  return new Error("Runner socket unavailable after 10000ms deadline", {
    cause: Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }),
  });
}

function failedRecoveryRunner(): {
  runner: NonNullable<Task["runner"]>;
  detachHost: ReturnType<typeof vi.fn>;
} {
  const detachHost = vi.fn(async () => {});
  return {
    runner: {
      dispatcher: { detachHost } as NonNullable<Task["runner"]>["dispatcher"],
      engine: {} as NonNullable<Task["runner"]>["engine"],
      eventPersistence: "runner",
    },
    detachHost,
  };
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
    registrationId: "registration-a",
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
