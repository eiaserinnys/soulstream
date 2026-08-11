import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RunnerReleaseDescriptor,
  RunnerReleaseMaterializer,
} from "../../src/runner/runner_release_materializer.js";
import {
  RunnerReleasePool,
  type RunnerReleasePoolDependencies,
} from "../../src/runner/runner_release_pool.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerReleasePool", () => {
  it("treats release ids as opaque path-safe values", async () => {
    const root = await temporaryDirectory();
    const materializer = new FakeMaterializer("manifest-v2_2026.08");
    const pool = new RunnerReleasePool(root, materializer);

    expect(await pool.resolveCurrentRelease()).toEqual({
      releaseId: "manifest-v2_2026.08",
      releaseRoot: join(root, "manifest-v2_2026.08"),
      runnerModuleRoot: join(root, "manifest-v2_2026.08"),
    });
    expect(() => pool.describe("../escape")).toThrow("opaque path-safe segment");
  });

  it("materializes one immutable release for concurrent first spawns", async () => {
    const root = await temporaryDirectory();
    const materializer = new FakeMaterializer("release-a", 20);
    const pool = new RunnerReleasePool(root, materializer);
    const release = await pool.resolveCurrentRelease();

    await Promise.all([
      pool.ensureRelease(release),
      pool.ensureRelease(release),
      pool.ensureRelease(release),
    ]);

    expect(materializer.materialize).toHaveBeenCalledOnce();
    expect(materializer.verify).toHaveBeenCalled();
    expect(await pool.listReadyReleases()).toEqual([release]);
  });

  it("fails loudly on materialization errors without publishing a live-checkout fallback", async () => {
    const root = await temporaryDirectory();
    const materializer = new FakeMaterializer("release-full");
    materializer.materialize.mockRejectedValueOnce(
      Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
    );
    const pool = new RunnerReleasePool(root, materializer);
    const release = await pool.resolveCurrentRelease();

    await expect(pool.ensureRelease(release)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await pool.listReadyReleases()).toEqual([]);
  });

  it("uses a verified ready release even when a prior host left its lock behind", async () => {
    const root = await temporaryDirectory();
    const materializer = new FakeMaterializer("release-ready");
    const pool = new RunnerReleasePool(root, materializer);
    const release = await pool.resolveCurrentRelease();
    await pool.ensureRelease(release);
    const materializeCalls = materializer.materialize.mock.calls.length;
    await writeLock(root, release.releaseId, { pid: 4401, startIdentity: "dead-host" });

    await expect(pool.ensureRelease(release)).resolves.toBeUndefined();
    expect(materializer.materialize).toHaveBeenCalledTimes(materializeCalls);
  });

  it("reclaims a stale lock after proving its owner process is dead", async () => {
    const root = await temporaryDirectory();
    const materializer = new FakeMaterializer("release-stale");
    const releaseId = "release-stale";
    await writeLock(root, releaseId, { pid: 4402, startIdentity: "old-process" });
    const pool = new RunnerReleasePool(
      root,
      materializer,
      100,
      lockDependencies({ alive: false, startIdentity: null }),
    );

    await expect(pool.ensureRelease(pool.describe(releaseId))).resolves.toBeUndefined();
    expect(materializer.materialize).toHaveBeenCalledOnce();
  });

  it("reclaims a reused PID only when its process start identity differs", async () => {
    const root = await temporaryDirectory();
    const materializer = new FakeMaterializer("release-reused-pid");
    const releaseId = "release-reused-pid";
    await writeLock(root, releaseId, { pid: 4403, startIdentity: "old-process" });
    const pool = new RunnerReleasePool(
      root,
      materializer,
      100,
      lockDependencies({ alive: true, startIdentity: "new-process" }),
    );

    await expect(pool.ensureRelease(pool.describe(releaseId))).resolves.toBeUndefined();
    expect(materializer.materialize).toHaveBeenCalledOnce();
  });

  it("never reclaims a lock while the exact owner process is alive", async () => {
    const root = await temporaryDirectory();
    const materializer = new FakeMaterializer("release-live-lock");
    const releaseId = "release-live-lock";
    await writeLock(root, releaseId, { pid: 4404, startIdentity: "same-process" });
    const pool = new RunnerReleasePool(
      root,
      materializer,
      100,
      lockDependencies({ alive: true, startIdentity: "same-process" }),
    );

    await expect(pool.ensureRelease(pool.describe(releaseId))).rejects.toThrow(
      "runner release lock timed out",
    );
    expect(materializer.materialize).not.toHaveBeenCalled();
  });
});

class FakeMaterializer implements RunnerReleaseMaterializer {
  readonly materialize = vi.fn(async (release: RunnerReleaseDescriptor) => {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    await mkdir(release.runnerModuleRoot, { recursive: true });
    await writeFile(join(release.releaseRoot, ".runner-release.json"), "ready\n");
    await writeFile(join(release.runnerModuleRoot, "runner_entry.js"), "");
    this.ready.add(release.releaseId);
  });
  readonly verify = vi.fn(async (release: RunnerReleaseDescriptor) => {
    if (!this.ready.has(release.releaseId)) {
      throw Object.assign(new Error("not ready"), { code: "ENOENT" });
    }
  });
  readonly remove = vi.fn(async (release: RunnerReleaseDescriptor) => {
    this.ready.delete(release.releaseId);
    await rm(release.releaseRoot, { recursive: true, force: true });
  });
  private readonly ready = new Set<string>();

  constructor(
    private readonly currentReleaseId: string,
    private readonly delayMs = 0,
  ) {}

  async resolveCurrentReleaseId(): Promise<string> {
    return this.currentReleaseId;
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runner-release-pool-"));
  directories.push(directory);
  return directory;
}

async function writeLock(
  root: string,
  releaseId: string,
  owner: { pid: number; startIdentity: string },
): Promise<void> {
  const lockPath = join(root, ".locks", releaseId);
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), JSON.stringify(owner));
}

function lockDependencies(
  inspected: { alive: boolean; startIdentity: string | null },
): RunnerReleasePoolDependencies {
  let now = 0;
  return {
    now: () => now,
    delay: async (ms) => { now += ms; },
    currentOwner: async () => ({ pid: 9999, startIdentity: "test-owner" }),
    inspectProcess: async () => inspected,
  };
}
