import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RunnerRecoveryCoordinator,
  type RunnerRecoveryCoordinatorOptions,
} from "../../src/runner/runner_recovery_coordinator.js";
import {
  classifyRunnerRegistration,
  scanRunnerRegistrations,
  type RunnerRegistration,
} from "../../src/runner/runner_process_registry.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import type { Task } from "../../src/task/task_models.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("RunnerRecoveryCoordinator exception matrix", () => {
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

  it("CLI-only failure replays its durable terminal error without runner auto-resume", async () => {
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
      "adopt",
    );
    expect(subject.markRunnerFailureAndResume).not.toHaveBeenCalled();
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
    const never = new Promise<void>(() => {});
    const recoverRegisteredRunner = vi.fn(() => never);
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
    await subject.coordinator.stop();
  });

  it("a live but stale progress lease is killed before offline drain and resume", async () => {
    const subject = makeSubject([registration({
      progressedAt: "2026-08-11T00:00:00.000Z",
    })], Date.parse("2026-08-11T00:03:00.000Z"));

    await subject.coordinator.scanOnce();
    await vi.waitFor(() => expect(subject.restartRegisteredRunner).toHaveBeenCalledOnce());

    expect(subject.terminate).toHaveBeenCalledOnce();
    expect(subject.markRunnerFailureAndResume).toHaveBeenCalledWith(
      subject.task,
      "runner progress lease expired",
      expect.any(Function),
    );
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

  it("disk or registration read failure is loud and does not invent recovery state", async () => {
    const error = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    const subject = makeSubject([], Date.now(), [{ directory: "/runner/a", error }]);

    await subject.coordinator.scanOnce();

    expect(subject.logger.error).toHaveBeenCalledWith(
      { directory: "/runner/a", error },
      "runner registration is unreadable",
    );
    expect(subject.recoverRegisteredRunner).not.toHaveBeenCalled();
    expect(subject.markRunnerFailureAndResume).not.toHaveBeenCalled();
  });

  it("isolates a disk-full reap write without killing the scan or resuming invented state", async () => {
    const error = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    const subject = makeSubject([registration({ pidAlive: false })], Date.now(), [], {
      markReaped: vi.fn().mockRejectedValue(error),
    });

    await expect(subject.coordinator.scanOnce()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(subject.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error,
        sessionId: "session-a",
        disposition: "reap_dead",
      }),
      "runner recovery action failed",
    ));

    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.markRunnerFailureAndResume).not.toHaveBeenCalled();
  });
});

describe("classifyRunnerRegistration", () => {
  const now = Date.parse("2026-08-11T00:00:30.000Z");

  it("preserves the registration-before-spawn grace window without inventing a death", () => {
    const pending = {
      ...registration({ pidAlive: false }),
      registeredAtMs: now - 1_000,
      bootstrap: null,
      lifecycle: null,
    };

    expect(classifyRunnerRegistration(pending, now, 120_000)).toBe("wait_for_bootstrap");
    expect(classifyRunnerRegistration(
      { ...pending, registeredAtMs: now - 120_000 },
      now,
      120_000,
    )).toBe("reap_dead");
  });

  it("gives a durable terminal state priority over process liveness", () => {
    expect(classifyRunnerRegistration(registration({
      pidAlive: false,
      lifecycleState: "failed",
    }), now, 120_000)).toBe("replay_terminal");
  });

  it("reports a missing registered database without recreating empty recovery state", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "runner-registry-"));
    temporaryDirectories.push(stateDirectory);
    const paths = runnerProcessPaths(stateDirectory, "session-a");
    await mkdir(paths.sessionDirectory, { recursive: true });
    await writeFile(paths.configPath, JSON.stringify({
      ...registration().config,
      paths,
    }));

    const result = await scanRunnerRegistrations(stateDirectory);

    expect(result.registrations).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ directory: paths.sessionDirectory }),
    ]);
    await expect(access(paths.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
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
    logger,
    spawner: { terminate },
    scan: async () => ({ registrations, errors }),
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
    terminate,
    logger,
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
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    pid: 4123,
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
