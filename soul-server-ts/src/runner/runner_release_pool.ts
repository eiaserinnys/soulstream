import { randomUUID } from "node:crypto";
import { mkdir, readdir, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  RunnerReleaseDescriptor,
  RunnerReleaseMaterializer,
} from "./runner_release_materializer.js";

const DEFAULT_LOCK_TIMEOUT_MS = 300_000;
const LOCK_RETRY_MS = 50;

interface RunnerReleasePoolDependencies {
  now(): number;
  delay(ms: number): Promise<void>;
}

export class RunnerReleasePool {
  constructor(
    readonly releasesDirectory: string,
    readonly materializer: RunnerReleaseMaterializer,
    private readonly lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    private readonly deps: RunnerReleasePoolDependencies = defaultDependencies(),
  ) {
    if (!releasesDirectory) throw new Error("runner releases directory required");
    if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs <= 0) {
      throw new Error("runner release lock timeout must be positive");
    }
  }

  async resolveCurrentRelease(): Promise<RunnerReleaseDescriptor> {
    return this.describe(await this.materializer.resolveCurrentReleaseId());
  }

  describe(releaseId: string): RunnerReleaseDescriptor {
    assertOpaqueReleaseId(releaseId);
    const releaseRoot = join(this.releasesDirectory, releaseId);
    return {
      releaseId,
      releaseRoot,
      runnerModuleRoot: releaseRoot,
    };
  }

  async ensureRelease(release: RunnerReleaseDescriptor): Promise<void> {
    this.assertDescriptor(release);
    await this.withReleaseLock(release.releaseId, async () => {
      if (await this.isReady(release)) return;
      const stagingPath = join(
        this.releasesDirectory,
        ".staging",
        `${release.releaseId}-${process.pid}-${randomUUID()}`,
      );
      await this.materializer.materialize(release, stagingPath);
      await this.materializer.verify(release);
    });
  }

  async listReadyReleases(): Promise<RunnerReleaseDescriptor[]> {
    let entries;
    try {
      entries = await readdir(this.releasesDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const releases: RunnerReleaseDescriptor[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        const release = this.describe(entry.name);
        if (await this.isReady(release)) releases.push(release);
      } catch {
        // Unknown directories are not owned by this pool and are never deleted.
      }
    }
    return releases;
  }

  async removeReleaseLocked(release: RunnerReleaseDescriptor): Promise<void> {
    this.assertDescriptor(release);
    await this.materializer.remove(release);
  }

  async withReleaseLock<T>(releaseId: string, operation: () => Promise<T>): Promise<T> {
    assertOpaqueReleaseId(releaseId);
    const lockRoot = join(this.releasesDirectory, ".locks");
    const lockPath = join(lockRoot, releaseId);
    await mkdir(lockRoot, { recursive: true });
    const deadline = this.deps.now() + this.lockTimeoutMs;
    while (true) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (this.deps.now() >= deadline) {
          throw new Error(`runner release lock timed out: ${releaseId}`);
        }
        await this.deps.delay(LOCK_RETRY_MS);
      }
    }
    try {
      return await operation();
    } finally {
      await rmdir(lockPath);
    }
  }

  private async isReady(release: RunnerReleaseDescriptor): Promise<boolean> {
    try {
      await this.materializer.verify(release);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private assertDescriptor(release: RunnerReleaseDescriptor): void {
    const expected = this.describe(release.releaseId);
    if (
      resolve(release.releaseRoot) !== resolve(expected.releaseRoot)
      || resolve(release.runnerModuleRoot) !== resolve(expected.runnerModuleRoot)
    ) {
      throw new Error(`runner release path escaped its pool: ${release.releaseId}`);
    }
  }
}

export function assertOpaqueReleaseId(value: string): void {
  if (!value || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error("runner release id must be one opaque path-safe segment");
  }
}

function defaultDependencies(): RunnerReleasePoolDependencies {
  return {
    now: Date.now,
    delay: async (ms) => await new Promise((resolveDelay) => setTimeout(resolveDelay, ms)),
  };
}
