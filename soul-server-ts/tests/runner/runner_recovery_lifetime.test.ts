import { describe, expect, it, vi } from "vitest";

import {
  RunnerRecoveryCoordinator,
  type RunnerRecoveryCoordinatorOptions,
} from "../../src/runner/runner_recovery_coordinator.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import type { Task } from "../../src/task/task_models.js";

const NOW_MS = Date.parse("2026-08-24T02:30:07.900Z");

describe("RunnerRecoveryCoordinator recovery lifetime", () => {
  it("settles and retires one terminal admission without an offline replay", async () => {
    const terminal = runnerRegistration({ lifecycleState: "completed", pidAlive: true });
    const task = runnerTask();
    const settlement = deferred<void>();
    const harness = makeHarness({
      registration: terminal,
      task,
      retire: async () => {
        task.status = "completed";
        task.terminationReason = "completed_ok";
        task.terminationEventRecorded = true;
        task.terminalEventId = 12;
        settlement.resolve();
      },
    });
    task.runner = harness.runner;
    task.executionPromise = settlement.promise.finally(() => {
      task.executionPromise = undefined;
    });

    await harness.coordinator.scanOnce();
    await harness.coordinator.waitForSettled();

    expect(harness.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(harness.detachHost).not.toHaveBeenCalled();
    expect(harness.terminate).not.toHaveBeenCalled();
    expect(harness.recoveryModes).toEqual([]);
  });

  it("terminalizes failed adoption through offline replay without a replacement", async () => {
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

    expect(harness.recoveryModes).toEqual(["adopt", "offline"]);
  });
});

type RecoveryMode = "adopt" | "replay" | "offline";

function makeHarness(input: {
  registration: RunnerRegistration;
  task?: Task;
  hydrate?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
  refreshRegistration?: (registration: RunnerRegistration) => Promise<RunnerRegistration>;
  retire?: () => Promise<void>;
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
  const retireTerminalRegistration = vi.fn(
    async (beforeRegistrationRetired?: () => Promise<void>) => {
      await input.retire?.();
      await beforeRegistrationRetired?.();
    },
  );
  const runner = {
    dispatcher: {
      detachHost,
      retireTerminalRegistration,
      isClosed: () => detached,
      hasActiveExecution: () => false,
      dispatcherId: () => "runner-a",
      registrationId: () => "registration-a",
    },
    engine: {},
    eventPersistence: "runner",
  } as unknown as NonNullable<Task["runner"]>;
  const recoveryModes: RecoveryMode[] = [];
  const terminate = vi.fn(async () => {});
  const invalidateRegistration = vi.fn(async () => {});
  const markRunnerFailure = vi.fn(async () => {});
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
      markRunnerFailure,
      projectClosedRunner: vi.fn(async () => true),
    } as never,
    taskExecutor: {
      recoverRegisteredRunner: recoverRegisteredRunner as never,
      retainRegisteredClaudeBackgroundRunner: vi.fn(async () => false),
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
    retireTerminalRegistration,
    terminate,
    recoveryModes,
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
