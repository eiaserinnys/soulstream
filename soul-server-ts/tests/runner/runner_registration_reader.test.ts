import { appendFile, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readRunnerRegistrationSummary } from "../../src/runner/runner_registration_reader.js";
import {
  scanRunnerRegistrations,
} from "../../src/runner/runner_process_registry.js";
import { runnerProcessPaths } from "../../src/runner/runner_process_paths.js";
import type { RunnerChildConfig } from "../../src/runner/runner_process_spawn.js";
import {
  pendingRunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "../../src/runner/runner_registration_identity.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "../../src/runner/sqlite_runner_lifecycle.js";
import { RunnerRegistrationScanCache } from "../../src/runner/runner_registration_scan_cache.js";
import * as sqliteConnection from "../../src/runner/runner_sqlite_connection.js";
import { RunnerHostStateStore, runnerHostStatePath } from "../../src/runner/runner_host_state_store.js";
import * as processLock from "../../src/runner/runner_process_lock.js";

const temporaryDirectories: string[] = [];
const CURRENT_PID = process.pid;
const STALE_PID = 2_147_483_601;
const CURRENT_START_IDENTITY = "current-runner-start";
const OTHER_START_IDENTITY = "other-runner-start";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("terminal registration scan cache", () => {
  async function subject() {
    const fixture = await writeRegistrationFixture("cached-terminal", {
      identity: "absent", sidecarPid: STALE_PID, lifecyclePid: STALE_PID,
    });
    await writeRunnerRegistrationIdentity(fixture.paths.sessionDirectory, {
      ...pendingRunnerRegistrationIdentity("session-cached-terminal", "release-a"),
      retiredAt: "2026-10-12T00:00:00.000Z",
    });
    let now = 0;
    const cache = new RunnerRegistrationScanCache(() => now);
    const fresh = vi.fn(async () => await readRunnerRegistrationSummary(
      fixture.paths.sessionDirectory,
      { verifyProcessIdentity: true, inspectWriterLock: async () => ({ kind: "free" }) },
    ));
    const read = async () => await cache.read(fixture.paths.sessionDirectory, fresh);
    return { ...fixture, cache, fresh, read, advance: () => { now += 300_000; } };
  }

  it("opens no SQLite DB on a repeated terminal read, while the direct reader still rechecks", async () => {
    const s = await subject();
    const open = vi.spyOn(sqliteConnection, "openRunnerSqliteReadOnlyDatabase");
    const first = await s.read();
    expect(open).toHaveBeenCalledOnce();
    expect((await stat(`${s.paths.databasePath}-wal`)).size).toBe(0);
    open.mockClear();
    // The cold read creates WAL/shm. It cannot establish an unchanged proof.
    expect(await s.read()).toEqual(first);
    expect(open).toHaveBeenCalledOnce();
    open.mockClear();
    // Only the second full read has a stable fingerprint; the third reuses it.
    expect(await s.read()).toEqual(first);
    expect(open).not.toHaveBeenCalled();
    await s.fresh();
    expect(open).toHaveBeenCalled();
  });

  it.each(["runner-wal", "host-db", "host-wal", "pid"] as const)(
    "rechecks when a new %s file appears or grows", async (kind) => {
      const s = await subject();
      await s.read();
      await s.read();
      const host = runnerHostStatePath(s.paths.databasePath);
      const path = kind === "runner-wal" ? `${s.paths.databasePath}-wal`
        : kind === "host-db" ? host
        : kind === "host-wal" ? `${host}-wal` : s.paths.pidPath;
      if (kind === "pid") {
        await writeFile(path, `${process.pid}\n`);
      } else {
        // The reader tolerates these auxiliary files for a retired registration;
        // their appearance must still invalidate the scan's previous proof.
        await appendFile(path, "changed");
      }
      const open = vi.spyOn(sqliteConnection, "openRunnerSqliteReadOnlyDatabase");
      await s.read();
      expect(open).toHaveBeenCalled();
      expect(s.fresh).toHaveBeenCalledTimes(3);
    },
  );

  it("rechecks a same-size replacement even when mtime is restored", async () => {
    const s = await subject();
    await s.read();
    await s.read();
    const before = await stat(s.paths.pidPath);
    const replacement = `${s.paths.pidPath}.replacement`;
    await writeFile(replacement, `${STALE_PID}\n`);
    await utimes(replacement, before.atime, before.mtime);
    await rename(replacement, s.paths.pidPath);
    await s.read();
    expect(s.fresh).toHaveBeenCalledTimes(3);
  });

  it("forces a fresh proof after five minutes and after pruning", async () => {
    const s = await subject();
    await s.read();
    await s.read();
    s.advance();
    await s.read();
    expect(s.fresh).toHaveBeenCalledTimes(3);
    s.cache.prune(new Set());
    await s.read();
    expect(s.fresh).toHaveBeenCalledTimes(4);
  });

  it("rechecks when the cached dead PID is reused without a file change", async () => {
    const s = await subject();
    await s.read();
    await s.read();
    await s.read();
    expect(s.fresh).toHaveBeenCalledTimes(2);
    vi.spyOn(processLock, "isProcessAlive").mockReturnValue(true);
    await s.read();
    expect(s.fresh).toHaveBeenCalledTimes(3);
  });

  it("reuses an acknowledged closed tail and discovers an actual WAL append", async () => {
    const fixture = await writeRegistrationFixture("closed-cached", {
      identity: "absent", sidecarPid: STALE_PID, lifecyclePid: STALE_PID,
    });
    const lifecycle = RunnerSqliteLifecycle.open(fixture.paths.databasePath);
    lifecycle.finish("execute-closed-cached", "closed", "2026-10-12T00:00:00.000Z");
    lifecycle.close();
    const writer = await RunnerSqliteEventOutbox.open(fixture.paths.databasePath);
    const streamId = writer.streamId;
    writer.close();
    const host = RunnerHostStateStore.open(runnerHostStatePath(fixture.paths.databasePath));
    host.initializeEventCheckpoint({
      streamId, sessionId: "session-closed-cached", acknowledgedThrough: 1,
    });
    host.close();
    const cache = new RunnerRegistrationScanCache();
    const read = async () => await cache.read(fixture.paths.sessionDirectory, async () =>
      await readRunnerRegistrationSummary(fixture.paths.sessionDirectory, {
        verifyProcessIdentity: true, inspectWriterLock: async () => ({ kind: "free" }),
      }));
    await read();
    await read();
    const open = vi.spyOn(sqliteConnection, "openRunnerSqliteReadOnlyDatabase");
    expect((await read()).closedTailState?.status).toBe("fully_acknowledged");
    expect(open).not.toHaveBeenCalled();
    const appender = await RunnerSqliteEventOutbox.open(fixture.paths.databasePath);
    try {
      await appender.append({
        session_id: "session-closed-cached", event_type: "assistant", payload: { text: "tail" },
        searchable_text: "tail", created_at: "2026-10-12T00:00:01.000Z",
        semantic_dedupe_key: null, session_effect: null,
      });
      open.mockClear();
      expect((await read()).closedTailState).toMatchObject({
        status: "requires_drain", latestDurableSourceSeq: 2, acknowledgedThrough: 1,
      });
      expect(open).toHaveBeenCalled();
    } finally {
      appender.close();
    }
  });

  it("measures a warm scan with 62 retired and four live SQLite registrations", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "runner-scan-66-"));
    temporaryDirectories.push(stateDirectory);
    const livePaths = new Set<string>();
    for (let i = 0; i < 66; i++) {
      const live = i >= 62;
      const label = `scan-${i}`;
      const fixture = await writeRegistrationFixture(label, {
        stateDirectory,
        identity: live ? "complete" : "absent",
        sidecarPid: live ? CURRENT_PID : STALE_PID,
        lifecyclePid: live ? CURRENT_PID : STALE_PID,
      });
      if (live) livePaths.add(fixture.paths.lockPath);
      else await writeRunnerRegistrationIdentity(fixture.paths.sessionDirectory, {
        ...pendingRunnerRegistrationIdentity(`session-${label}`, "release-a"),
        retiredAt: "2026-10-12T00:00:00.000Z",
      });
    }
    const options = {
      inspectWriterLock: async (path: string) => livePaths.has(path)
        ? { kind: "held" as const, owner: { pid: CURRENT_PID, startIdentity: CURRENT_START_IDENTITY } }
        : { kind: "free" as const },
    };
    const cache = new RunnerRegistrationScanCache();
    const cachedOptions = { ...options, cache };
    // Prime both paths. Compare one actual scan each after cold WAL creation.
    await scanRunnerRegistrations(stateDirectory, options);
    await scanRunnerRegistrations(stateDirectory, cachedOptions);
    await scanRunnerRegistrations(stateDirectory, cachedOptions);
    const open = vi.spyOn(sqliteConnection, "openRunnerSqliteReadOnlyDatabase");
    async function measure(input: typeof options & { cache?: RunnerRegistrationScanCache }) {
      open.mockClear();
      let lastTick = performance.now();
      let maxTimerGapMs = 0;
      let stallsOver50Ms = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        const gap = now - lastTick;
        maxTimerGapMs = Math.max(maxTimerGapMs, gap);
        if (gap > 50) stallsOver50Ms += 1;
        lastTick = now;
      }, 1);
      try {
        const start = performance.now();
        const scan = await scanRunnerRegistrations(stateDirectory, input);
        const durationMs = performance.now() - start;
        await new Promise((resolve) => setTimeout(resolve, 2));
        expect(scan.errors).toEqual([]);
        expect(scan.registrations).toHaveLength(66);
        expect(scan.registrations.filter((registration) => registration.pidAlive)).toHaveLength(4);
        return { durationMs, maxTimerGapMs, stallsOver50Ms, databaseOpens: open.mock.calls.length };
      } finally {
        clearInterval(timer);
      }
    }
    const before = await measure(options);
    const after = await measure(cachedOptions);
    expect(before.databaseOpens).toBe(66);
    expect(after.databaseOpens).toBe(4);
    console.info("runner warm scan measurement", JSON.stringify({ before, after }));
  });

  it("always rechecks a live runner and a closed runner with an unacknowledged tail", async () => {
    const fixture = await writeRegistrationFixture("uncached-live", {
      identity: "complete", sidecarPid: CURRENT_PID, lifecyclePid: CURRENT_PID,
    });
    const cache = new RunnerRegistrationScanCache();
    const fresh = vi.fn(async () => await readFixture(fixture, CURRENT_START_IDENTITY));
    await cache.read(fixture.paths.sessionDirectory, fresh);
    await cache.read(fixture.paths.sessionDirectory, fresh);
    expect(fresh).toHaveBeenCalledTimes(2);
    const lifecycle = RunnerSqliteLifecycle.open(fixture.paths.databasePath);
    lifecycle.finish("execute-uncached-live", "closed", "2026-10-12T00:00:00.000Z");
    lifecycle.close();
    const dead = vi.fn(async () => await readRunnerRegistrationSummary(
      fixture.paths.sessionDirectory,
      { verifyProcessIdentity: true, inspectWriterLock: async () => ({ kind: "free" }) },
    ));
    expect((await cache.read(fixture.paths.sessionDirectory, dead)).closedTailState?.status)
      .toBe("requires_drain");
    await cache.read(fixture.paths.sessionDirectory, dead);
    expect(dead).toHaveBeenCalledTimes(2);
  });
});

describe("runner registration reader", () => {
  it("scans a respawned runner while the lifecycle still names the previous process", async () => {
    const fixture = await writeRegistrationFixture("respawn", {
      identity: "complete",
      sidecarPid: CURRENT_PID,
      lifecyclePid: STALE_PID,
    });

    const result = await scanRunnerRegistrations(
      fixture.stateDirectory,
      heldLockOptions(CURRENT_START_IDENTITY),
    );

    expect(result.errors).toEqual([]);
    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0]).toMatchObject({
      pid: CURRENT_PID,
      pidAlive: true,
      pidStartIdentity: CURRENT_START_IDENTITY,
      lifecycle: { runner_pid: STALE_PID },
    });
  });

  it("uses the held kernel lock when a complete identity conflicts with a stale pid sidecar", async () => {
    const fixture = await writeRegistrationFixture("sidecar-conflict", {
      identity: "complete",
      sidecarPid: STALE_PID,
      lifecyclePid: CURRENT_PID,
    });

    await expect(readFixture(fixture, CURRENT_START_IDENTITY)).resolves.toMatchObject({
      pid: CURRENT_PID,
      pidAlive: true,
    });
  });

  it("treats conflicting live PID evidence as dead residue when the kernel lock is free", async () => {
    const fixture = await writeRegistrationFixture("reused-pid-free-lock", {
      identity: "complete",
      sidecarPid: STALE_PID,
      lifecyclePid: CURRENT_PID,
    });

    await expect(readRunnerRegistrationSummary(fixture.paths.sessionDirectory, {
      verifyProcessIdentity: true,
      inspectWriterLock: async () => ({ kind: "free" }),
    })).resolves.toMatchObject({
      pid: CURRENT_PID,
      pidAlive: false,
    });
  });

  it("marks a complete identity dead when the held lock has another start identity", async () => {
    const fixture = await writeRegistrationFixture("start-identity-conflict", {
      identity: "complete",
      sidecarPid: CURRENT_PID,
      lifecyclePid: CURRENT_PID,
    });

    await expect(readFixture(fixture, OTHER_START_IDENTITY)).resolves.toMatchObject({
      pid: CURRENT_PID,
      pidAlive: false,
      pidStartIdentity: CURRENT_START_IDENTITY,
    });
  });

  it("stops advertising a registration after three unavailable lock scans", async () => {
    const fixture = await writeRegistrationFixture("unavailable-lock", {
      identity: "complete",
      sidecarPid: CURRENT_PID,
      lifecyclePid: CURRENT_PID,
    });

    const options: Parameters<typeof readRunnerRegistrationSummary>[1] = {
      verifyProcessIdentity: true,
      inspectWriterLock: async () => ({ kind: "unavailable" }),
    };

    const first = await readRunnerRegistrationSummary(fixture.paths.sessionDirectory, options);
    const second = await readRunnerRegistrationSummary(fixture.paths.sessionDirectory, options);
    const third = await readRunnerRegistrationSummary(fixture.paths.sessionDirectory, options);

    expect([first.pidAlive, second.pidAlive, third.pidAlive]).toEqual([true, true, false]);
  });

  it.each(["absent", "pending"] as const)(
    "keeps lifecycle pid fallback when the identity is %s",
    async (identity) => {
      const fixture = await writeRegistrationFixture(`fallback-${identity}`, {
        identity,
        sidecarPid: null,
        lifecyclePid: CURRENT_PID,
      });

      await expect(readFixture(fixture, CURRENT_START_IDENTITY)).resolves.toMatchObject({
        pid: CURRENT_PID,
        pidAlive: true,
        lifecycle: { runner_pid: CURRENT_PID },
      });
    },
  );

  it.each(["absent", "pending"] as const)(
    "uses the held kernel lock when pid sidecar and lifecycle disagree and identity is %s",
    async (identity) => {
      const fixture = await writeRegistrationFixture(`conflict-${identity}`, {
        identity,
        sidecarPid: CURRENT_PID,
        lifecyclePid: STALE_PID,
      });

      await expect(readFixture(fixture, CURRENT_START_IDENTITY)).resolves.toMatchObject({
        pid: CURRENT_PID,
        pidAlive: true,
      });
    },
  );
});

type IdentityState = "absent" | "pending" | "complete";

async function writeRegistrationFixture(
  label: string,
  evidence: {
    stateDirectory?: string;
    identity: IdentityState;
    sidecarPid: number | null;
    lifecyclePid: number;
  },
) {
  const stateDirectory = evidence.stateDirectory
    ?? await mkdtemp(join(tmpdir(), `runner-reader-${label}-`));
  if (!evidence.stateDirectory) temporaryDirectories.push(stateDirectory);
  const sessionId = `session-${label}`;
  const paths = runnerProcessPaths(stateDirectory, sessionId);
  const config: RunnerChildConfig = {
    schemaVersion: 1,
    sessionId,
    backend: "codex",
    agent: {
      id: "agent-a",
      name: "Agent A",
      backend: "codex",
      workspace_dir: "/workspace",
    },
    paths,
    codeSha: "release-a",
    snapshotPath: "/release/release-a",
    codexAdapterMode: "sdk",
    claudeRuntimeV2Enabled: true,
    claudeRuntimeIdleTtlMs: 300_000,
    claudeRuntimeMaxEntries: 16,
    claudeRuntimeTurnTimeoutMs: 1_800_000,
    internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
    codexHome: "/home/test/.codex",
    rolloutRoot: "/home/test/.codex/sessions",
  };
  await mkdir(paths.sessionDirectory, { recursive: true });
  await writeFile(paths.configPath, JSON.stringify(config));
  if (evidence.sidecarPid !== null) {
    await writeFile(paths.pidPath, `${evidence.sidecarPid}\n`);
  }
  if (evidence.identity !== "absent") {
    const pending = pendingRunnerRegistrationIdentity(sessionId, config.codeSha);
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, evidence.identity === "complete"
      ? {
          ...pending,
          pid: CURRENT_PID,
          startIdentity: CURRENT_START_IDENTITY,
        }
      : pending);
  }
  const outbox = await RunnerSqliteEventOutbox.create(paths.databasePath);
  await outbox.initializeBootstrap({
    session_id: sessionId,
    created_at: "2026-09-05T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: `backend-${label}`,
      cwd: "/workspace",
      codex_home: config.codexHome,
      rollout_root: config.rolloutRoot,
      code_sha: config.codeSha,
      snapshot_path: config.snapshotPath,
    },
  });
  outbox.close();
  const lifecycle = RunnerSqliteLifecycle.open(paths.databasePath, sessionId);
  lifecycle.begin({
    pid: evidence.lifecyclePid,
    commandId: `execute-${label}`,
    progressedAt: "2026-09-05T00:00:01.000Z",
  });
  lifecycle.close();
  return { stateDirectory, paths };
}

function heldLockOptions(startIdentity: string) {
  const options: Parameters<typeof readRunnerRegistrationSummary>[1] = {
    verifyProcessIdentity: true,
    inspectWriterLock: async () => ({
      kind: "held",
      owner: { pid: CURRENT_PID, startIdentity },
    }),
  };
  return options;
}

async function readFixture(
  fixture: Awaited<ReturnType<typeof writeRegistrationFixture>>,
  startIdentity: string,
) {
  return await readRunnerRegistrationSummary(
    fixture.paths.sessionDirectory,
    heldLockOptions(startIdentity),
  );
}
