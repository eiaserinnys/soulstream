import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RunnerProcessSpawner } from "../../src/runner/runner_process_spawn.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerProcessSpawner", () => {
  it("registers SQLite before detached spawn and executes the immutable snapshot entry", async () => {
    const calls: string[] = [];
    const spawnProcess = vi.fn((entry: string, args: string[], options: unknown) => {
      calls.push("spawn");
      expect(entry).toBe("/releases/sha-a/soul-server-ts/dist/runner/runner_entry.js");
      expect(args[0]).toBe("--config");
      expect(options).toMatchObject({ detached: true, stdio: "ignore" });
      return { pid: 4123, unref: vi.fn() };
    });
    const spawner = new RunnerProcessSpawner({
      prepareDatabase: vi.fn(async () => { calls.push("database"); }),
      validateEntry: vi.fn(async () => { calls.push("entry"); }),
      spawnProcess,
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      isPidAlive: () => false,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });

    const spawned = await spawner.spawn(await input());

    expect(calls).toEqual(["database", "entry", "spawn"]);
    expect(spawned.pid).toBe(4123);
    expect(spawned.adopted).toBe(false);
    expect(await readFile(spawned.paths.pidPath, "utf8")).toBe("4123\n");
    expect(JSON.parse(await readFile(spawned.paths.configPath, "utf8"))).toMatchObject({
      sessionId: "session-a",
      codeSha: "sha-a",
      snapshotPath: "/releases/sha-a/soul-server-ts",
    });
  });

  it("terminates a live prior pid before spawning its replacement", async () => {
    let alive = true;
    const signals: NodeJS.Signals[] = [];
    const params = await input();
    const first = new RunnerProcessSpawner({
      prepareDatabase: async () => {},
      validateEntry: async () => {},
      spawnProcess: () => ({ pid: 5001, unref: vi.fn() }),
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      isPidAlive: () => false,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });
    const registered = await first.spawn(params);
    await writeFile(registered.paths.pidPath, "4001\n");
    const replacement = new RunnerProcessSpawner({
      prepareDatabase: async () => {},
      validateEntry: async () => {},
      spawnProcess: () => ({ pid: 5002, unref: vi.fn() }),
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      isPidAlive: (pid) => pid === 4001 && alive,
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

  it("adopts a live registered runner without spawning or replacing it", async () => {
    const params = await input();
    const first = new RunnerProcessSpawner({
      prepareDatabase: async () => {},
      validateEntry: async () => {},
      spawnProcess: () => ({ pid: 5101, unref: vi.fn() }),
      isPidAlive: () => false,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });
    const registered = await first.spawn(params);
    const spawnProcess = vi.fn(() => ({ pid: 5102, unref: vi.fn() }));
    const adopter = new RunnerProcessSpawner({
      prepareDatabase: async () => {},
      validateEntry: async () => {},
      spawnProcess,
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

  it("fails before spawn when the immutable snapshot entry is unavailable", async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5003, unref: vi.fn() }));
    const spawner = new RunnerProcessSpawner({
      prepareDatabase: async () => {},
      validateEntry: async () => { throw new Error("snapshot entry missing"); },
      spawnProcess,
      registerPid: async (path, pid) => await writeFile(path, `${pid}\n`, { mode: 0o600 }),
      isPidAlive: () => false,
      signalPid: vi.fn(),
      now: () => 0,
      delay: async () => {},
    });

    await expect(spawner.spawn(await input())).rejects.toThrow("snapshot entry missing");
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
      prepareDatabase: async () => {},
      validateEntry: async () => {},
      spawnProcess: () => ({ pid: 5004, unref }),
      registerPid: async () => { throw new Error("pid registration denied"); },
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
    snapshotPath: "/releases/sha-a/soul-server-ts",
    codexAdapterMode: "sdk" as const,
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    codexHome: "/home/eias/.codex",
    rolloutRoot: "/home/eias/.codex/sessions",
  };
}
