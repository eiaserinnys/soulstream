import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  RunnerReleaseDescriptor,
  RunnerReleaseMaterializer,
} from "../../src/runner/runner_release_materializer.js";
import { RunnerReleasePool } from "../../src/runner/runner_release_pool.js";

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
