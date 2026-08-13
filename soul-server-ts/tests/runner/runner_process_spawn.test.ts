import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { RunnerProcessSpawner } from "../../src/runner/runner_process_spawn.js";
import { readAuthoritativeRunnerLifecycle } from "../../src/runner/runner_lifecycle_reader.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";
import {
  readRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";

const directories: string[] = [];
const SNAPSHOT_PATH = join(tmpdir(), "runner-releases", "sha-a");
// Immutable runner snapshots deployed before the host update embed this
// discriminator. Unknown fields are intentionally irrelevant to this contract.
const LegacyRunnerSnapshotConfigSchema = z.object({
  schemaVersion: z.literal(1),
}).passthrough();

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerProcessSpawner", () => {
  it("writes config readable by immutable v1 snapshots before executing their entry", async () => {
    const calls: string[] = [];
    const spawnProcess = vi.fn((entry: string, args: string[], options: unknown) => {
      calls.push("spawn");
      expect(entry).toBe(join(SNAPSHOT_PATH, "runner_entry.js"));
      expect(args[0]).toBe("--config");
      expect(options).toMatchObject({
        detached: true,
        cwd: SNAPSHOT_PATH,
      });
      expect((options as { stdio: unknown[] }).stdio).toEqual([
        "ignore",
        expect.any(Number),
        expect.any(Number),
      ]);
      return { pid: 4123, unref: vi.fn() };
    });
    const spawner = new RunnerProcessSpawner({
      prepareDatabase: vi.fn(async (path) => {
        await prepareDatabase(path);
        calls.push("database");
      }),
      validateEntry: vi.fn(async () => { calls.push("entry"); }),
      spawnProcess,
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async (pid) => ({ alive: true, startIdentity: `test-${pid}` }),
      isPidAlive: () => false,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });

    const params = await input();
    params.prepareSnapshot = vi.fn(async () => {
      const paths = runnerProcessPaths(params.stateDirectory, params.sessionId);
      expect(JSON.parse(await readFile(paths.configPath, "utf8"))).toMatchObject({
        codeSha: "sha-a",
      });
      calls.push("snapshot");
    });
    const spawned = await spawner.spawn(params);

    expect(calls).toEqual(["database", "snapshot", "entry", "spawn"]);
    expect(spawned.pid).toBe(4123);
    expect(spawned.adopted).toBe(false);
    expect(await readFile(spawned.paths.pidPath, "utf8")).toBe("4123\n");
    await expect(readRunnerRegistrationIdentity(spawned.paths.sessionDirectory)).resolves.toEqual({
      schemaVersion: 1,
      registrationId: expect.any(String),
      sessionId: "session-a",
      codeSha: "sha-a",
      pid: 4123,
      startIdentity: "test-4123",
    });
    const writtenConfig = JSON.parse(await readFile(spawned.paths.configPath, "utf8"));
    expect(LegacyRunnerSnapshotConfigSchema.parse(writtenConfig)).toMatchObject({
      schemaVersion: 1,
    });
    expect(writtenConfig).toMatchObject({
      schemaVersion: 1,
      sessionId: "session-a",
      codeSha: "sha-a",
      snapshotPath: SNAPSHOT_PATH,
      runnerLeaseTimeoutMs: 120_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      paths: { logPath: expect.stringMatching(/runner\.log$/) },
    });
  });

  it("terminates a live prior pid before spawning its replacement", async () => {
    let alive = true;
    const signals: NodeJS.Signals[] = [];
    const params = await input();
    const first = new RunnerProcessSpawner({
      prepareDatabase,
      validateEntry: async () => {},
      spawnProcess: () => ({ pid: 5001, unref: vi.fn() }),
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async (pid) => ({ alive: true, startIdentity: `test-${pid}` }),
      isPidAlive: () => false,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });
    const registered = await first.spawn(params);
    const replacement = new RunnerProcessSpawner({
      prepareDatabase,
      validateEntry: async () => {},
      spawnProcess: () => ({ pid: 5002, unref: vi.fn() }),
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async (pid) => ({ alive: true, startIdentity: `test-${pid}` }),
      isPidAlive: (pid) => pid === 5001 && alive,
      signalPid: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
      now: () => 0,
      delay: async () => {},
    });

    await replacement.spawn(params);

    expect(signals).toEqual(["SIGTERM"]);
  });

  it("waits a fresh grace window after SIGKILL before declaring termination failure", async () => {
    let now = 0;
    let alive = true;
    const signals: NodeJS.Signals[] = [];
    const params = await input();
    const initial = new RunnerProcessSpawner({
      prepareDatabase, validateEntry: async () => {},
      spawnProcess: () => ({ pid: 6101, unref: vi.fn() }),
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async () => ({ alive: true, startIdentity: "start-6101" }),
      isPidAlive: () => false, signalPid: vi.fn(), now: () => now, delay: async () => {},
    });
    const registered = await initial.spawn(params);
    const replacement = new RunnerProcessSpawner({
      prepareDatabase, validateEntry: async () => {},
      spawnProcess: () => ({ pid: 6102, unref: vi.fn() }),
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async (pid) => ({
        alive: pid === 6102 ? true : alive,
        startIdentity: `start-${pid}`,
      }),
      isPidAlive: (pid) => pid === 6101 && alive,
      signalPid: (_pid, signal) => { signals.push(signal); },
      now: () => now,
      delay: async () => {
        now += 25;
        if (signals.includes("SIGKILL") && now >= 2_025) alive = false;
      },
    });

    await replacement.spawn(params);

    expect(registered.pid).toBe(6101);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(now).toBeGreaterThan(2_000);
  });

  it("refuses SIGKILL when the pid start identity changes during grace", async () => {
    let now = 0;
    let inspections = 0;
    const params = await input();
    const initial = new RunnerProcessSpawner({
      prepareDatabase, validateEntry: async () => {},
      spawnProcess: () => ({ pid: 6201, unref: vi.fn() }),
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async () => ({ alive: true, startIdentity: "start-6201" }),
      isPidAlive: () => false, signalPid: vi.fn(), now: () => now, delay: async () => {},
    });
    await initial.spawn(params);
    const signalPid = vi.fn();
    const replacement = new RunnerProcessSpawner({
      prepareDatabase, validateEntry: async () => {},
      spawnProcess: () => ({ pid: 6202, unref: vi.fn() }),
      registerPid: async () => {},
      inspectProcess: async () => ({
        alive: true,
        startIdentity: ++inspections === 1 ? "start-6201" : "reused-process",
      }),
      isPidAlive: (pid) => pid === 6201,
      signalPid,
      now: () => now,
      delay: async () => { now += 25; },
    });

    await expect(replacement.spawn(params)).rejects.toThrow(
      "runner process identity changed before SIGKILL",
    );
    expect(signalPid).toHaveBeenCalledOnce();
    expect(signalPid).toHaveBeenCalledWith(6201, "SIGTERM");
  });

  it("never removes writer-lock ownership evidence while preparing a replacement", async () => {
    const params = await input();
    const paths = runnerProcessPaths(params.stateDirectory, params.sessionId);
    await mkdir(paths.sessionDirectory, { recursive: true });
    await writeFile(paths.lockPath, "prior-runner-ownership\n");
    const spawner = new RunnerProcessSpawner({
      prepareDatabase,
      validateEntry: async () => {},
      spawnProcess: () => ({ pid: 5006, unref: vi.fn() }),
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async (pid) => ({ alive: true, startIdentity: `test-${pid}` }),
      isPidAlive: () => false,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });

    await spawner.spawn(params);

    await expect(readFile(paths.lockPath, "utf8"))
      .resolves.toBe("prior-runner-ownership\n");
  });

  it("adopts a live registered runner without spawning or replacing it", async () => {
    const params = await input();
    const first = new RunnerProcessSpawner({
      prepareDatabase,
      validateEntry: async () => {},
      spawnProcess: () => ({ pid: 5101, unref: vi.fn() }),
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async (pid) => ({ alive: true, startIdentity: `test-${pid}` }),
      isPidAlive: () => false,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });
    const registered = await first.spawn(params);
    const spawnProcess = vi.fn(() => ({ pid: 5102, unref: vi.fn() }));
    const adopter = new RunnerProcessSpawner({
      prepareDatabase,
      validateEntry: async () => {},
      spawnProcess,
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async (pid) => ({ alive: true, startIdentity: `test-${pid}` }),
      isPidAlive: (pid) => pid === 5101,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });

    await expect(adopter.adopt({
      stateDirectory: params.stateDirectory,
      sessionId: params.sessionId,
    })).resolves.toEqual({ ...registered, adopted: true });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("recovers across a persistent sidecar failure and runner pid generation change", async () => {
    const params = await input();
    const paths = runnerProcessPaths(params.stateDirectory, params.sessionId);
    const initializeDatabase = async (path: string) => {
      const outbox = await RunnerSqliteEventOutbox.create(path);
      await outbox.initializeBootstrap({
        session_id: params.sessionId,
        created_at: "2026-08-12T00:00:00.000Z",
        resume: {
          schema_version: 1,
          backend_session_id: "backend-a",
          cwd: params.agent.workspace_dir,
          codex_home: params.codexHome,
          rollout_root: params.rolloutRoot,
          code_sha: params.codeSha,
          snapshot_path: params.snapshotPath,
        },
      });
      outbox.close();
    };
    const initial = new RunnerProcessSpawner({
      prepareDatabase: initializeDatabase,
      validateEntry: async () => {},
      spawnProcess: () => ({ pid: 5101, unref: vi.fn() }),
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async (pid) => ({ alive: true, startIdentity: `test-${pid}` }),
      isPidAlive: () => false,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });
    await initial.spawn(params);
    const firstLifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
    await firstLifecycle.begin({
      pid: 5101,
      commandId: "execute-old",
      progressedAt: "2026-08-12T00:00:01.000Z",
    });
    firstLifecycle.close();

    const persistentRenameFailure = vi.fn(() => {
      throw Object.assign(new Error("sidecar remains locked"), { code: "EPERM" });
    });
    const nextLifecycle = RunnerSqliteLifecycle.open(paths.databasePath, undefined, {
      renameFile: persistentRenameFailure,
      retryDelaysMs: [],
    });
    await nextLifecycle.begin({
      pid: 5102,
      commandId: "execute-new",
      progressedAt: "2026-08-12T00:00:02.000Z",
    });
    nextLifecycle.close();
    await writeFile(paths.pidPath, "5102\n", { mode: 0o600 });
    const priorIdentity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
    expect(priorIdentity).not.toBeNull();
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, {
      ...priorIdentity!,
      pid: 5102,
      startIdentity: "test-5102",
    });

    let runnerAlive = true;
    const signalPid = vi.fn((_pid: number) => { runnerAlive = false; });
    const spawnProcess = vi.fn(() => ({ pid: 5103, unref: vi.fn() }));
    const recoveredHost = new RunnerProcessSpawner({
      prepareDatabase,
      validateEntry: async () => {},
      spawnProcess,
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async (pid) => ({ alive: true, startIdentity: `test-${pid}` }),
      isPidAlive: (pid) => pid === 5102 && runnerAlive,
      signalPid,
      now: () => 0,
      delay: async () => {},
      readLifecycle: async (path) => await readAuthoritativeRunnerLifecycle(path, {
        lifecycleSummaryOptions: {
          renameFile: persistentRenameFailure,
        },
      }),
    });

    await expect(recoveredHost.adopt({
      stateDirectory: params.stateDirectory,
      sessionId: params.sessionId,
    })).resolves.toMatchObject({ pid: 5102, adopted: true });
    await expect(recoveredHost.spawn(params)).resolves.toMatchObject({ pid: 5103, adopted: false });

    expect(persistentRenameFailure).toHaveBeenCalledTimes(3);
    expect(signalPid).toHaveBeenCalledWith(5102, "SIGTERM");
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("fails before spawn when the immutable snapshot entry is unavailable", async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5003, unref: vi.fn() }));
    const spawner = new RunnerProcessSpawner({
      prepareDatabase,
      validateEntry: async () => { throw new Error("snapshot entry missing"); },
      spawnProcess,
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async (pid) => ({ alive: true, startIdentity: `test-${pid}` }),
      isPidAlive: () => false,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });

    await expect(spawner.spawn(await input())).rejects.toThrow("snapshot entry missing");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("registers config before materialization and never spawns after materialization failure", async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5005, unref: vi.fn() }));
    let configRegistered = false;
    const params = await input();
    params.prepareSnapshot = async () => {
      const paths = runnerProcessPaths(params.stateDirectory, params.sessionId);
      configRegistered = JSON.parse(await readFile(paths.configPath, "utf8")).codeSha === "sha-a";
      expect(configRegistered).toBe(true);
      throw Object.assign(new Error("disk full while materializing"), { code: "ENOSPC" });
    };
    const spawner = new RunnerProcessSpawner({
      prepareDatabase,
      validateEntry: async () => {},
      spawnProcess,
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      inspectProcess: async (pid) => ({ alive: true, startIdentity: `test-${pid}` }),
      isPidAlive: () => false,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });

    await expect(spawner.spawn(params)).rejects.toThrow("disk full while materializing");
    expect(configRegistered).toBe(true);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("kills the detached child when pid registration fails", async () => {
    let alive = true;
    const unref = vi.fn();
    const signalPid = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      expect(signal).toBe("SIGKILL");
      alive = false;
    });
    const spawner = new RunnerProcessSpawner({
      prepareDatabase,
      validateEntry: async () => {},
      spawnProcess: () => ({ pid: 5004, unref }),
      registerPid: async () => { throw new Error("pid registration denied"); },
      inspectProcess: async (pid) => ({ alive: true, startIdentity: `test-${pid}` }),
      isPidAlive: (pid) => pid === 5004 && alive,
      signalPid,
      now: () => 0,
      delay: async () => {},
    });

    await expect(spawner.spawn(await input())).rejects.toThrow("pid registration denied");

    expect(signalPid).toHaveBeenCalledOnce();
    expect(alive).toBe(false);
    expect(unref).toHaveBeenCalledOnce();
  });
});

async function input() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "soulstream-runner-spawn-"));
  directories.push(stateDirectory);
  return {
    stateDirectory,
    sessionId: "session-a",
    backend: "codex" as const,
    agent: {
      id: "agent-a",
      name: "Agent A",
      backend: "codex" as const,
      workspace_dir: "/workspace/agent-a",
    },
    codeSha: "sha-a",
    snapshotPath: SNAPSHOT_PATH,
    codexAdapterMode: "sdk" as const,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    runnerLeaseTimeoutMs: 120_000,
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: "/home/eias/.codex",
    rolloutRoot: "/home/eias/.codex/sessions",
  };
}

async function prepareDatabase(path: string): Promise<void> {
  const outbox = await RunnerSqliteEventOutbox.create(path);
  outbox.close();
}
