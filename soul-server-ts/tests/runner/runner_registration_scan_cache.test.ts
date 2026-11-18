import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RunnerRegistrationScanCache } from "../../src/runner/runner_registration_scan_cache.js";
import { RunnerRegistrationScanCacheSnapshot } from "../../src/runner/runner_registration_scan_cache_snapshot.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";

const FULL_RECHECK_INTERVAL_MS = 300_000;
const SCAN_INTERVAL_MS = 15_000;
const START = Date.parse("2026-11-17T00:00:00.000Z");

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("persistent registration scan cache", () => {
  it("restores hits, rereads changed fingerprints, and spreads rechecks", async () => {
    const root = await makeStateDirectory();
    let now = START;
    const first = new RunnerRegistrationScanCache(() => now);
    const fresh = new Map<string, ReturnType<typeof vi.fn>>();
    const directories = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      makeRegistrationDirectory(root, `persist-${i}`)));
    for (const [i, directory] of directories.entries()) {
      fresh.set(directory, vi.fn(async () => terminalRegistration(`persist-${i}`)));
      await first.read(directory, fresh.get(directory)!, i);
    }
    const store = new RunnerRegistrationScanCacheSnapshot(root, first);
    expect(await store.persist()).toBe(true);
    now += 10_000;
    const restored = new RunnerRegistrationScanCache(() => now);
    expect(await new RunnerRegistrationScanCacheSnapshot(root, restored).restore())
      .toEqual({ restored: 4, discarded: 0 });
    await readAll(restored, directories, fresh);
    expect(freshReads(fresh)).toBe(4);
    await appendFile(join(directories[3]!, "runner-config.json"), " ");
    await restored.read(directories[3]!, fresh.get(directories[3]!)!, 3);
    expect(freshReads(fresh)).toBe(5);
    now += FULL_RECHECK_INTERVAL_MS + SCAN_INTERVAL_MS;
    await readAll(restored, directories, fresh);
    expect(freshReads(fresh)).toBe(7);
  });

  it("starts empty for missing, incompatible, or broken snapshots and discards malformed entries", async () => {
    const root = await makeStateDirectory();
    const path = join(root, ".registration-scan-cache.json");
    const cache = new RunnerRegistrationScanCache(() => START);
    const store = new RunnerRegistrationScanCacheSnapshot(root, cache);
    expect(await store.restore()).toEqual({ restored: 0, discarded: 0, reason: "missing" });
    await writeFile(path, JSON.stringify({ version: -1, entries: [] }));
    expect(await store.restore()).toEqual({ restored: 0, discarded: 0, reason: "version" });
    await writeFile(path, "{");
    expect(await store.restore()).toEqual({ restored: 0, discarded: 0, reason: "parse" });
    const directory = await makeRegistrationDirectory(root, "valid");
    await cache.read(directory, async () => terminalRegistration("valid"));
    await store.persist();
    const snapshot = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
    snapshot.entries.push({ ...snapshot.entries[0], registration: { ...snapshot.entries[0].registration, config: {} } });
    await writeFile(path, JSON.stringify(snapshot));
    const fresh = new RunnerRegistrationScanCache(() => START);
    expect(await new RunnerRegistrationScanCacheSnapshot(root, fresh).restore())
      .toEqual({ restored: 1, discarded: 1 });
  });

  it("writes only when snapshot content changes, not after a full recheck alone", async () => {
    const root = await makeStateDirectory();
    const directory = await makeRegistrationDirectory(root, "unchanged");
    let now = START;
    let current = terminalRegistration("unchanged");
    const cache = new RunnerRegistrationScanCache(() => now);
    const store = new RunnerRegistrationScanCacheSnapshot(root, cache);
    await cache.read(directory, async () => current);
    expect(await store.persist()).toBe(true);
    now += FULL_RECHECK_INTERVAL_MS;
    await cache.read(directory, async () => current);
    expect(await store.persist()).toBe(false);
    now += FULL_RECHECK_INTERVAL_MS;
    current = { ...current, retiredAt: "2026-11-17T00:00:00.000Z" };
    await cache.read(directory, async () => current);
    expect(await store.persist()).toBe(true);
  });
});

async function makeStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-scan-cache-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeRegistrationDirectory(root: string, name: string): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "runner-config.json"), "{}");
  return directory;
}

function terminalRegistration(sessionId: string): RunnerRegistration {
  return {
    config: {
      schemaVersion: 1, sessionId, backend: "codex",
      agent: { id: "agent-a", name: "Agent A", backend: "codex", workspace_dir: "/workspace/a" },
      paths: {
        sessionDirectory: `/runner/${sessionId}`, databasePath: `/runner/${sessionId}/runner.sqlite`,
        socketPath: `/runner/${sessionId}/runner.sock`, pidPath: `/runner/${sessionId}/runner.pid`,
        lockPath: `/runner/${sessionId}/runner.lock`, configPath: `/runner/${sessionId}/runner-config.json`,
      },
      codeSha: "sha-a", snapshotPath: "/release/sha-a", codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true, claudeRuntimeIdleTtlMs: 300_000, claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 600_000, internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: null, rolloutRoot: null,
    },
    pid: null,
    pidAlive: false,
    registeredAtMs: 0,
    bootstrap: null,
    lifecycle: null,
    retiredAt: "2026-10-12T00:00:00.000Z",
  } as unknown as RunnerRegistration;
}

async function readAll(
  cache: RunnerRegistrationScanCache,
  directories: string[],
  fresh: Map<string, ReturnType<typeof vi.fn>>,
): Promise<void> {
  for (const [position, directory] of directories.entries()) {
    await cache.read(directory, fresh.get(directory)!, position);
  }
}

function freshReads(fresh: Map<string, ReturnType<typeof vi.fn>>): number {
  return [...fresh.values()].reduce((total, spy) => total + spy.mock.calls.length, 0);
}

describe("runner registration scan cache recheck jitter", () => {
  it("splits registrations recorded at the same instant across later scans", async () => {
    const root = await makeStateDirectory();
    const directories: string[] = [];
    const fresh = new Map<string, ReturnType<typeof vi.fn>>();
    let now = START;
    const cache = new RunnerRegistrationScanCache(() => now);
    for (let position = 0; position < 12; position++) {
      const directory = await makeRegistrationDirectory(root, `session-${position}`);
      directories.push(directory);
      fresh.set(directory, vi.fn(async () => terminalRegistration(`session-${position}`)));
      await cache.read(directory, fresh.get(directory)!, position);
    }
    expect(freshReads(fresh)).toBe(directories.length);

    // 전체 재확인 간격이 지난 첫 스캔. 같은 때 기록됐어도 한 항목만 다시 읽는다.
    now = START + FULL_RECHECK_INTERVAL_MS;
    await readAll(cache, directories, fresh);
    expect(freshReads(fresh)).toBe(directories.length + 1);

    // 다음 스캔에서 한 항목이 더 만료된다. 나머지는 아직 캐시를 쓴다.
    now = START + FULL_RECHECK_INTERVAL_MS + SCAN_INTERVAL_MS;
    await readAll(cache, directories, fresh);
    expect(freshReads(fresh)).toBe(directories.length + 2);
  });

  it("rechecks every registration within twice the previous interval", async () => {
    const root = await makeStateDirectory();
    const directories: string[] = [];
    const fresh = new Map<string, ReturnType<typeof vi.fn>>();
    let now = START;
    const cache = new RunnerRegistrationScanCache(() => now);
    for (let position = 0; position < 21; position++) {
      const directory = await makeRegistrationDirectory(root, `session-${position}`);
      directories.push(directory);
      fresh.set(directory, vi.fn(async () => terminalRegistration(`session-${position}`)));
      await cache.read(directory, fresh.get(directory)!, position);
    }

    now = START + FULL_RECHECK_INTERVAL_MS * 2;
    await readAll(cache, directories, fresh);
    expect(freshReads(fresh)).toBe(directories.length * 2);
  });

  it("keeps the previous five-minute recheck when a read has no scan position", async () => {
    const root = await makeStateDirectory();
    const directory = await makeRegistrationDirectory(root, "session-single");
    let now = START;
    const cache = new RunnerRegistrationScanCache(() => now);
    const fresh = vi.fn(async () => terminalRegistration("session-single"));
    await cache.read(directory, fresh);
    await cache.read(directory, fresh);
    expect(fresh).toHaveBeenCalledOnce();
    now = START + FULL_RECHECK_INTERVAL_MS;
    await cache.read(directory, fresh);
    expect(fresh).toHaveBeenCalledTimes(2);
  });
});

describe("runner registration scan cache miss counts", () => {
  it("counts why each scan had to read a registration fresh", async () => {
    const root = await makeStateDirectory();
    const directory = await makeRegistrationDirectory(root, "session-a");
    let now = START;
    const cache = new RunnerRegistrationScanCache(() => now);
    const fresh = vi.fn(async () => terminalRegistration("session-a"));

    await cache.read(directory, fresh);
    expect(cache.missCounts()).toEqual({
      uncacheable: 0, fingerprintChanged: 0, fullRecheckExpired: 0, notCached: 1,
    });
    await cache.read(directory, fresh);
    expect(cache.missCounts()).toEqual({
      uncacheable: 0, fingerprintChanged: 0, fullRecheckExpired: 0, notCached: 1,
    });

    await appendFile(join(directory, "runner-config.json"), " ");
    await cache.read(directory, fresh);
    expect(cache.missCounts()).toEqual({
      uncacheable: 0, fingerprintChanged: 1, fullRecheckExpired: 0, notCached: 1,
    });

    now += FULL_RECHECK_INTERVAL_MS;
    await cache.read(directory, fresh);
    expect(cache.missCounts()).toEqual({
      uncacheable: 0, fingerprintChanged: 1, fullRecheckExpired: 1, notCached: 1,
    });

    const liveDirectory = await makeRegistrationDirectory(root, "session-live");
    const live = vi.fn(async () => ({
      ...terminalRegistration("session-live"),
      retiredAt: undefined,
      pid: 4_242,
      pidAlive: true,
    }) as unknown as RunnerRegistration);
    await cache.read(liveDirectory, live);
    expect(cache.missCounts()).toEqual({
      uncacheable: 1, fingerprintChanged: 1, fullRecheckExpired: 1, notCached: 1,
    });

    cache.resetMissCounts();
    expect(cache.missCounts()).toEqual({
      uncacheable: 0, fingerprintChanged: 0, fullRecheckExpired: 0, notCached: 0,
    });
    await cache.read(directory, fresh);
    expect(cache.missCounts()).toEqual({
      uncacheable: 0, fingerprintChanged: 0, fullRecheckExpired: 0, notCached: 0,
    });
  });

  it("counts a fingerprint that changes while the registration is read as uncacheable", async () => {
    const root = await makeStateDirectory();
    const directory = await makeRegistrationDirectory(root, "session-churn");
    const cache = new RunnerRegistrationScanCache(() => START);
    let mutated = false;
    const fresh = vi.fn(async () => {
      if (!mutated) {
        mutated = true;
        await writeFile(join(directory, "runner.pid"), "4242\n");
      }
      return terminalRegistration("session-churn");
    });

    await cache.read(directory, fresh);
    expect(cache.missCounts()).toEqual({
      uncacheable: 1, fingerprintChanged: 0, fullRecheckExpired: 0, notCached: 0,
    });

    await cache.read(directory, fresh);
    expect(cache.missCounts()).toEqual({
      uncacheable: 1, fingerprintChanged: 0, fullRecheckExpired: 0, notCached: 1,
    });
    await cache.read(directory, fresh);
    expect(fresh).toHaveBeenCalledTimes(2);
  });
});
