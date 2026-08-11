import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  RunnerReleaseDescriptor,
  RunnerReleaseMaterializer,
} from "./runner_release_materializer.js";
import {
  ProcessOwnershipDirectoryLock,
  defaultProcessOwnershipLockDependencies,
  type ProcessOwnershipLockDependencies,
} from "./runner_process_lock.js";

const DEFAULT_LOCK_TIMEOUT_MS = 300_000;
export type RunnerReleasePoolDependencies = ProcessOwnershipLockDependencies;

export class RunnerReleasePool {
  constructor(
    readonly releasesDirectory: string,
    readonly materializer: RunnerReleaseMaterializer,
    private readonly lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    private readonly deps: RunnerReleasePoolDependencies = defaultProcessOwnershipLockDependencies(),
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
    const lock = await ProcessOwnershipDirectoryLock.acquire({
      path: join(this.releasesDirectory, ".locks", releaseId),
      timeoutMs: this.lockTimeoutMs,
      heldMessage: `runner release lock timed out: ${releaseId}`,
      deps: this.deps,
    });
    try {
      return await operation();
    } finally {
      await lock.release();
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
