import { describe, expect, it, vi } from "vitest";

import {
  RunnerRecoveryCoordinator,
  type RunnerRecoveryCoordinatorOptions,
} from "../../src/runner/runner_recovery_coordinator.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import type { Task } from "../../src/task/task_models.js";

const NOW_MS = Date.parse("2026-08-24T02:30:07.900Z");

describe("RunnerRecoveryCoordinator recovery lifetime", () => {
  it("keeps reconciliation unsettled until a live adoption completes", async () => {
    const adoption = deferred<void>();
    const harness = makeHarness({
      registration: runnerRegistration({ lifecycleState: "running" }),
      recover: ({ mode }) => mode === "adopt" ? adoption.promise : Promise.resolve(),
    });

    await harness.coordinator.scanOnce();

    let settled = false;
    const waiting = harness.coordinator.waitForSettled().then(() => { settled = true; });
    await nextEventLoopTurn();
    const heldThroughAdoption = !settled;

    adoption.resolve();
    await waiting;

    expect(heldThroughAdoption).toBe(true);
    expect(settled).toBe(true);
  });

  it("skips terminal replay without blocking the scan while adoption owns the session", async () => {
    const adoption = deferred<void>();
    const harness = makeHarness({
      registration: runnerRegistration({ lifecycleState: "running" }),
      recover: ({ mode, task, runner }) => {
        if (mode !== "adopt") return Promise.resolve();
        const completion = adoption.promise.finally(() => {
          if (task.executionPromise === completion) task.executionPromise = undefined;
        });
        task.runner = runner;
        task.executionPromise = completion;
        return completion;
      },
    });
    await harness.coordinator.scanOnce();
    harness.setRegistration(runnerRegistration({ lifecycleState: "completed" }));

    let terminalScanSettled = false;
    const terminalScan = harness.coordinator.scanOnce().then(() => {
      terminalScanSettled = true;
    });
    await nextEventLoopTurn();
    const observationBeforeAdoptionCompleted = {
      detachCalls: harness.detachHost.mock.calls.length,
      offlineCalls: harness.recoveryModes.filter((mode) => mode === "offline").length,
      terminalScanSettled,
    };

    adoption.resolve();
    await terminalScan;
    await harness.coordinator.waitForSettled();
    await harness.coordinator.scanOnce();
    await harness.coordinator.waitForSettled();

    expect(observationBeforeAdoptionCompleted).toEqual({
      detachCalls: 0,
      offlineCalls: 0,
      terminalScanSettled: true,
    });
    expect(harness.detachHost).toHaveBeenCalledOnce();
    expect(harness.recoveryModes.filter((mode) => mode === "offline")).toHaveLength(1);
  });

  it("re-reads lifecycle on the next scan after the adoption owner settles", async () => {
    const adoption = deferred<void>();
    const harness = makeHarness({
      registration: runnerRegistration({ lifecycleState: "running" }),
      recover: ({ mode, task, runner }) => {
        if (mode !== "adopt") return Promise.resolve();
        const completion = adoption.promise.finally(() => {
          if (task.executionPromise === completion) task.executionPromise = undefined;
        });
        task.runner = runner;
        task.executionPromise = completion;
        return completion;
      },
    });
    await harness.coordinator.scanOnce();
    harness.setRegistration(runnerRegistration({ lifecycleState: "completed" }));

    let terminalScanSettled = false;
    const terminalScan = harness.coordinator.scanOnce().then(() => {
      terminalScanSettled = true;
    });
    await nextEventLoopTurn();
    const skippedWithoutWaiting = terminalScanSettled;
    adoption.resolve();
    await terminalScan;
    await harness.coordinator.waitForSettled();
    harness.setRegistration(runnerRegistration({ lifecycleState: "running" }));
    await harness.coordinator.scanOnce();
    await harness.coordinator.waitForSettled();

    expect(skippedWithoutWaiting).toBe(true);
    expect(harness.detachHost).not.toHaveBeenCalled();
    expect(harness.terminate).not.toHaveBeenCalled();
    expect(harness.recoveryModes).not.toContain("offline");
  });

  it("delivers an intervention admitted at the terminal boundary exactly once", async () => {
    const adoption = deferred<void>();
    let claimedByOldRunner = false;
    let pendingIntervention = true;
    const markers: string[] = [];
    const harness = makeHarness({
      registration: runnerRegistration({ lifecycleState: "running" }),
      hydrate: async (registration) => {
        if (registration.lifecycle?.execution_state === "completed") {
          await adoption.promise;
        }
        return registration;
      },
      recover: ({ mode, task, runner, isDetached }) => {
        if (mode === "offline") {
          if (pendingIntervention && !claimedByOldRunner) {
            markers.push("successor");
            pendingIntervention = false;
          }
          return Promise.resolve();
        }
        const completion = adoption.promise.then(() => {
          if (pendingIntervention && !isDetached()) {
            markers.push("old");
            pendingIntervention = false;
          }
        }).finally(() => {
          if (task.executionPromise === completion) task.executionPromise = undefined;
        });
        task.runner = runner;
        task.executionPromise = completion;
        return completion;
      },
    });
    await harness.coordinator.scanOnce();
    harness.setRegistration(runnerRegistration({ lifecycleState: "completed" }));

    let terminalScanSettled = false;
    const terminalScan = harness.coordinator.scanOnce().then(() => {
      terminalScanSettled = true;
    });
    await nextEventLoopTurn();
    const skippedWithoutWaiting = terminalScanSettled;
    claimedByOldRunner = true;
    adoption.resolve();
    await terminalScan;
    await harness.coordinator.waitForSettled();
    await harness.coordinator.scanOnce();
    await harness.coordinator.waitForSettled();

    expect(skippedWithoutWaiting).toBe(true);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatch(/^(old|successor)$/);
    expect(pendingIntervention).toBe(false);
  });

  it("starts terminal detach, termination, and offline replay in one owner-free scan", async () => {
    const terminal = runnerRegistration({ lifecycleState: "completed", pidAlive: true });
    const task = runnerTask();
    const harness = makeHarness({ registration: terminal, task });
    task.runner = harness.runner;
    task.executionPromise = new Promise<void>(() => {});

    await harness.coordinator.scanOnce();
    await harness.coordinator.waitForSettled();

    expect(harness.detachHost).toHaveBeenCalledOnce();
    expect(harness.terminate).toHaveBeenCalledOnce();
    expect(harness.recoveryModes).toEqual(["offline"]);
  });

  it("holds the recovery barrier until an adoption timeout reaches bounded failure recovery", async () => {
    const adoption = deferred<void>();
    const running = runnerRegistration({ lifecycleState: "running", pidAlive: true });
    const stopped = runnerRegistration({ lifecycleState: "running", pidAlive: false });
    const harness = makeHarness({
      registration: running,
      refreshRegistration: async () => stopped,
      recover: ({ mode }) => mode === "adopt" ? adoption.promise : Promise.resolve(),
    });
    await harness.coordinator.scanOnce();

    let settled = false;
    const waiting = harness.coordinator.waitForSettled().then(() => { settled = true; });
    await nextEventLoopTurn();
    const heldUntilTimeout = !settled;

    adoption.reject(new Error("runner turn inactivity timeout"));
    await waiting;
    await nextEventLoopTurn();
    await harness.coordinator.waitForSettled();

    expect(heldUntilTimeout).toBe(true);
    expect(harness.restartRegisteredRunnerUnderRecoveryLease).toHaveBeenCalledOnce();
  });

  it("does not start a replacement after stop returns when an admitted recovery later fails", async () => {
    const adoption = deferred<void>();
    const running = runnerRegistration({ lifecycleState: "running", pidAlive: true });
    const stopped = runnerRegistration({ lifecycleState: "running", pidAlive: false });
    const harness = makeHarness({
      registration: running,
      refreshRegistration: async () => stopped,
      recover: ({ mode }) => mode === "adopt" ? adoption.promise : Promise.resolve(),
    });
    await harness.coordinator.scanOnce();

    await harness.coordinator.stop();
    adoption.reject(new Error("runner turn inactivity timeout"));
    await harness.coordinator.waitForSettled();

    expect(harness.restartRegisteredRunnerUnderRecoveryLease).toHaveBeenCalledTimes(0);
  });

  it("reaches replacement after failed adoption without recursively acquiring its recovery lease", async () => {
    const running = runnerRegistration({ lifecycleState: "running", pidAlive: true });
    const stopped = runnerRegistration({ lifecycleState: "running", pidAlive: false });
    const harness = makeHarness({
      registration: running,
      refreshRegistration: async () => stopped,
      recover: ({ mode }) => mode === "adopt"
        ? Promise.reject(new Error("runner turn inactivity timeout"))
        : Promise.resolve(),
    });

    await harness.coordinator.scanOnce();
    await harness.coordinator.waitForSettled();

    expect(harness.nestedLeaseAttempts).toBe(0);
    expect(harness.replacementStarts).toBe(1);
  });
});

type RecoveryMode = "adopt" | "replay" | "offline";

function makeHarness(input: {
  registration: RunnerRegistration;
  task?: Task;
  hydrate?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
  refreshRegistration?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
  recover?: (input: {
    mode: RecoveryMode;
    task: Task;
    runner: NonNullable<Task["runner"]>;
    isDetached(): boolean;
  }) => Promise<void>;
}) {
  let scannedRegistration = input.registration;
  let detached = false;
  const task = input.task ?? runnerTask();
  const detachHost = vi.fn(async () => { detached = true; });
  const runner = {
    dispatcher: {
      detachHost,
      isClosed: () => detached,
      dispatcherId: () => "runner-a",
      registrationId: () => "registration-a",
    },
    engine: {},
    eventPersistence: "runner",
  } as unknown as NonNullable<Task["runner"]>;
  const recoveryModes: RecoveryMode[] = [];
  const terminate = vi.fn(async () => {});
  const invalidateRegistration = vi.fn(async () => {});
  const retireTerminalRegistration = vi.fn(async () => {});
  let recoveryLeaseHeld = false;
  let nestedLeaseAttempts = 0;
  let replacementStarts = 0;
  const withSessionRecoveryLease = async <T>(
    _sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (recoveryLeaseHeld) {
      nestedLeaseAttempts += 1;
      throw new Error("recursive session recovery lease acquisition");
    }
    recoveryLeaseHeld = true;
    try {
      return await operation();
    } finally {
      recoveryLeaseHeld = false;
    }
  };
  const restartRegisteredRunner = vi.fn(async () => {
    await withSessionRecoveryLease("session-a", async () => {
      replacementStarts += 1;
    });
  });
  const restartRegisteredRunnerUnderRecoveryLease = vi.fn(async () => {
    replacementStarts += 1;
  });
  const recoverRegisteredRunner = vi.fn((
    candidate: Task,
    _config: unknown,
    _commandId: string | undefined,
    mode: RecoveryMode,
    onAttemptCreated?: (attempt: NonNullable<Task["runner"]>) => void,
  ) => {
    recoveryModes.push(mode);
    onAttemptCreated?.(runner);
    return input.recover?.({
      mode,
      task: candidate,
      runner,
      isDetached: () => detached,
    }) ?? Promise.resolve();
  });
  const options: RunnerRecoveryCoordinatorOptions = {
    nodeId: "node-a",
    stateDirectory: "/runner",
    leaseTimeoutMs: 120_000,
    scanIntervalMs: 15_000,
    taskManager: {
      hydrateRunnerRecoveryTask: vi.fn(async () => task),
      markRunnerFailureAndResume: vi.fn(async (
        recoveredTask: Task,
        _message: string,
        resume: (candidate: Task) => void,
      ) => resume(recoveredTask)),
      listOwnerNullRunningInventory: vi.fn(async () => []),
      projectClosedRunner: vi.fn(async () => true),
      reconcileExecutionOwnershipObservations: vi.fn(async () => false),
    } as never,
    taskExecutor: {
      recoverRegisteredRunner: recoverRegisteredRunner as never,
      restartRegisteredRunner,
      restartRegisteredRunnerUnderRecoveryLease,
      withSessionRecoveryLease,
    },
    closedTailDrainer: { drain: vi.fn(async () => {}) },
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    spawner: { terminate, invalidateRegistration, retireTerminalRegistration },
    scan: async () => structuredClone({ registrations: [scannedRegistration], errors: [] }),
    hydrate: input.hydrate ?? (async (registration) => registration),
    ...(input.refreshRegistration
      ? { refreshRegistration: input.refreshRegistration }
      : {}),
    now: () => NOW_MS,
    markReaped: vi.fn(async () => {}),
  };
  return {
    coordinator: new RunnerRecoveryCoordinator(options),
    task,
    runner,
    detachHost,
    terminate,
    restartRegisteredRunner,
    restartRegisteredRunnerUnderRecoveryLease,
    recoveryModes,
    get nestedLeaseAttempts() {
      return nestedLeaseAttempts;
    },
    get replacementStarts() {
      return replacementStarts;
    },
    setRegistration(registration: RunnerRegistration) {
      scannedRegistration = registration;
    },
  };
}

function runnerRegistration(input: {
  lifecycleState: "running" | "completed";
  pidAlive?: boolean;
}): RunnerRegistration {
  return {
    config: {
      schemaVersion: 1,
      sessionId: "session-a",
      backend: "codex",
      agent: {
        id: "agent-a",
        name: "Agent A",
        backend: "codex",
        workspace_dir: "/workspace/a",
      },
      paths: {
        sessionDirectory: "/runner/session-a",
        databasePath: "/runner/session-a/runner.sqlite",
        socketPath: "/runner/session-a/runner.sock",
        pidPath: "/runner/session-a/runner.pid",
        lockPath: "/runner/session-a/runner.lock",
        configPath: "/runner/session-a/runner-config.json",
      },
      codeSha: "sha-a",
      snapshotPath: "/release/sha-a/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 600_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    pid: 260185,
    registrationId: "registration-a",
    pidStartIdentity: "start-260185",
    pidAlive: input.pidAlive ?? true,
    registeredAtMs: Date.parse("2026-08-24T02:29:30.000Z"),
    bootstrap: {
      stream_id: "stream-a",
      source_seq: 1,
      session_id: "session-a",
      event_type: "runner_bootstrap",
      payload: {
        schema_version: 1,
        backend_session_id: "backend-a",
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "sha-a",
        snapshot_path: "/release/sha-a/soul-server-ts",
      },
      searchable_text: null,
      created_at: "2026-08-24T02:29:30.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
      payload_hash: "0".repeat(64),
    },
    lifecycle: {
      session_id: "session-a",
      runner_pid: 260185,
      execution_command_id: "execute-a",
      execution_state: input.lifecycleState,
      progress_seq: 3,
      progress_at: "2026-08-24T02:30:07.800Z",
      liveness_at: "2026-08-24T02:30:07.800Z",
      in_flight_tools: [],
      terminal_error: null,
    },
  };
}

function runnerTask(): Task {
  return {
    agentSessionId: "session-a",
    prompt: "continue",
    status: "running",
    createdAt: new Date("2026-08-24T02:29:30.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
