import { createServer, type Server } from "node:net";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RunnerMutationFailure } from "../../src/runner/runner_mutation_failure.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import {
  RunnerProcessSpawner,
  type SpawnRunnerProcessInput,
} from "../../src/runner/runner_process_spawn.js";
import {
  pendingRunnerRegistrationIdentity,
  readRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { retireTerminalRunnerRegistrationFiles } from
  "../../src/runner/runner_registration_mutation.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";

const directories: string[] = [];
const ORIGINAL_PID = 73_101;
const RETRY_PID = 73_102;
const ORIGINAL_START_IDENTITY = "windows-process-638920800001230000";
const REUSED_START_IDENTITY = "windows-process-638920900001230000";

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("runner retirement blocker regressions", () => {
  it.skipIf(process.platform === "win32")(
    "restores a real Unix socket and pid evidence when the sidecar commit fails",
    async () => {
      const stateDirectory = await temporaryStateDirectory();
      const paths = runnerProcessPaths(stateDirectory, "unix-socket-rollback");
      await mkdir(paths.sessionDirectory, { recursive: true });
      const identity = {
        ...pendingRunnerRegistrationIdentity("unix-socket-rollback", "release-a"),
        pid: ORIGINAL_PID,
        startIdentity: ORIGINAL_START_IDENTITY,
      };
      await writeRunnerRegistrationIdentity(paths.sessionDirectory, identity);
      await writeFile(paths.pidPath, `${ORIGINAL_PID}\n`, { mode: 0o600 });
      const server = await listenOnUnixSocket(paths.socketPath);
      let commitAttempts = 0;

      try {
        const failure = await captureFailure(async () => {
          await retireTerminalRunnerRegistrationFiles(
            paths,
            identity.registrationId,
            new Date("2026-08-28T00:00:00.000Z"),
            {
              writeRegistrationIdentity: async () => {
                commitAttempts += 1;
                throw Object.assign(new Error("sidecar commit denied"), { code: "ENOSPC" });
              },
            },
          );
        });

        expect(failure).toBeInstanceOf(RunnerMutationFailure);
        expect(failure).toMatchObject({
          code: "runner_registration_persistence_failed",
          recoverable: true,
        });
        expect(commitAttempts).toBe(1);
        await expect(readFile(paths.pidPath, "utf8")).resolves.toBe(`${ORIGINAL_PID}\n`);
        await expect(lstat(paths.socketPath)).resolves.toMatchObject({});
        expect((await lstat(paths.socketPath)).isSocket()).toBe(true);
        await expect(readRunnerRegistrationIdentity(paths.sessionDirectory)).resolves.toEqual(identity);
        expect((await readRunnerRegistrationIdentity(paths.sessionDirectory))?.retiredAt)
          .toBeUndefined();
      } finally {
        await closeServer(server);
      }
    },
  );

  it("does not signal a reused PID while cleaning up a failed child registration", async () => {
    const harness = await createSpawnFailureHarness("pid_reuse");

    await expect(harness.spawner.spawn(harness.input)).rejects.toThrow("pid registration denied");

    expect(harness.signalPid).not.toHaveBeenCalled();
    expect(harness.spawnCount()).toBe(1);
    const identity = await readRunnerRegistrationIdentity(harness.paths.sessionDirectory);
    expect(identity).toMatchObject({ pid: null, startIdentity: null });
    expect(identity?.retiredAt).toBeUndefined();
    await expect(readFile(harness.paths.pidPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(harness.paths.socketPath, "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["signal_failure", "runner_termination_signal_failed"],
    ["exit_failure", "runner_termination_exit_proof_failed"],
  ] as const)(
    "preserves exact registration evidence after %s and succeeds on explicit retry",
    async (mode, expectedCode) => {
      const harness = await createSpawnFailureHarness(mode);

      const failure = await captureFailure(async () => {
        await harness.spawner.spawn(harness.input);
      });

      expect(failure).toBeInstanceOf(RunnerMutationFailure);
      expect(failure).toMatchObject({ code: expectedCode, recoverable: true });
      expect(harness.spawnCount()).toBe(1);
      const preservedIdentity = await readRunnerRegistrationIdentity(
        harness.paths.sessionDirectory,
      );
      expect(preservedIdentity).toMatchObject({
        pid: ORIGINAL_PID,
        startIdentity: ORIGINAL_START_IDENTITY,
      });
      expect(preservedIdentity?.retiredAt).toBeUndefined();
      await expect(readFile(harness.paths.pidPath, "utf8")).resolves
        .toBe(`${ORIGINAL_PID}\n`);
      await expect(readFile(harness.paths.socketPath, "utf8")).resolves
        .toBe(`socket-${ORIGINAL_PID}\n`);

      harness.allowCleanup();
      await expect(harness.spawner.spawn(harness.input)).resolves.toMatchObject({
        pid: RETRY_PID,
        adopted: false,
      });
      expect(harness.spawnCount()).toBe(2);
      await expect(readRunnerRegistrationIdentity(harness.paths.sessionDirectory)).resolves
        .toMatchObject({
          pid: RETRY_PID,
          startIdentity: `start-${RETRY_PID}`,
        });
    },
  );
});

type SpawnFailureMode = "pid_reuse" | "signal_failure" | "exit_failure";

async function createSpawnFailureHarness(mode: SpawnFailureMode) {
  const stateDirectory = await temporaryStateDirectory();
  const input = spawnInput(stateDirectory, `spawn-cleanup-${mode}`);
  const paths = runnerProcessPaths(stateDirectory, input.sessionId);
  const processes = new Map<number, { alive: boolean; startIdentity: string }>();
  let spawnCount = 0;
  let registerCount = 0;
  let now = 0;
  let cleanupAllowed = false;
  const signalPid = vi.fn((pid: number, _signal: NodeJS.Signals) => {
    const process = processes.get(pid);
    if (!process) throw new Error(`virtual process missing: ${pid}`);
    if (!cleanupAllowed && mode === "signal_failure") {
      throw new Error("termination signal denied");
    }
    if (!cleanupAllowed && mode === "exit_failure") return;
    process.alive = false;
  });
  const spawner = new RunnerProcessSpawner({
    prepareDatabase: async (databasePath) => {
      const outbox = await RunnerSqliteEventOutbox.create(databasePath);
      outbox.close();
    },
    validateEntry: async () => {},
    spawnProcess: () => {
      spawnCount += 1;
      const pid = spawnCount === 1 ? ORIGINAL_PID : RETRY_PID;
      processes.set(pid, {
        alive: true,
        startIdentity: pid === ORIGINAL_PID
          ? ORIGINAL_START_IDENTITY
          : `start-${pid}`,
      });
      return { pid, unref: vi.fn() };
    },
    waitForChildRegistrationIdentity: async (registrationPaths, pending, pid) => {
      const process = processes.get(pid);
      if (!process) throw new Error(`virtual process missing: ${pid}`);
      const completed = { ...pending, pid, startIdentity: process.startIdentity };
      await writeRunnerRegistrationIdentity(registrationPaths.sessionDirectory, completed);
      return completed;
    },
    registerPid: async (pidPath, pid) => {
      registerCount += 1;
      await writeFile(pidPath, `${pid}\n`, { mode: 0o600 });
      await writeFile(paths.socketPath, `socket-${pid}\n`, { mode: 0o600 });
      if (registerCount !== 1) return;
      if (mode === "pid_reuse") {
        processes.set(pid, { alive: true, startIdentity: REUSED_START_IDENTITY });
      }
      throw new Error("pid registration denied");
    },
    inspectProcess: async (pid) => {
      const process = processes.get(pid);
      return process?.alive
        ? { alive: true, startIdentity: process.startIdentity }
        : { alive: false, startIdentity: null };
    },
    isPidAlive: (pid) => processes.get(pid)?.alive ?? false,
    signalPid,
    now: () => now,
    delay: async (ms) => { now += ms; },
  });
  return {
    input,
    paths,
    spawner,
    signalPid,
    spawnCount: () => spawnCount,
    allowCleanup: () => { cleanupAllowed = true; },
  };
}

function spawnInput(stateDirectory: string, sessionId: string): SpawnRunnerProcessInput {
  return {
    stateDirectory,
    sessionId,
    backend: "codex",
    agent: {
      id: "agent-retirement-blocker",
      name: "Retirement Blocker",
      backend: "codex",
      workspace_dir: "/workspace/runner-retirement-blocker",
    },
    codeSha: "runner-retirement-blocker",
    snapshotPath: join(stateDirectory, "release"),
    codexAdapterMode: "sdk",
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 600_000,
    runnerLeaseTimeoutMs: 120_000,
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: "/home/test/.codex",
    rolloutRoot: "/home/test/.codex/sessions",
  };
}

async function temporaryStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-retirement-blocker-"));
  directories.push(directory);
  return directory;
}

async function listenOnUnixSocket(path: string): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function captureFailure(operation: () => Promise<void>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}
