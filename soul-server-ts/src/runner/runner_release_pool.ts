import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  RunnerReleaseDescriptor,
  RunnerReleaseMaterializer,
} from "./runner_release_materializer.js";

const DEFAULT_LOCK_TIMEOUT_MS = 300_000;
const LOCK_RETRY_MS = 50;

interface RunnerReleaseLockOwner {
  pid: number;
  startIdentity: string;
}

interface RunnerProcessIdentity {
  alive: boolean;
  startIdentity: string | null;
}

export interface RunnerReleasePoolDependencies {
  now(): number;
  delay(ms: number): Promise<void>;
  currentOwner(): Promise<RunnerReleaseLockOwner>;
  inspectProcess(pid: number): Promise<RunnerProcessIdentity>;
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
    // A completed immutable release is authoritative even if a previous host
    // died after publish but before removing its advisory lock directory.
    if (await this.isReady(release)) return;
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
        try {
          await writeFile(
            join(lockPath, "owner.json"),
            `${JSON.stringify(await this.deps.currentOwner())}\n`,
            { encoding: "utf8", flag: "wx" },
          );
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.reclaimStaleLock(lockPath)) continue;
        if (this.deps.now() >= deadline) {
          throw new Error(`runner release lock timed out: ${releaseId}`);
        }
        await this.deps.delay(LOCK_RETRY_MS);
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  private async reclaimStaleLock(lockPath: string): Promise<boolean> {
    const owner = await readLockOwner(lockPath);
    if (!owner) return false;
    const observed = await this.deps.inspectProcess(owner.pid);
    const stale = !observed.alive
      || (observed.startIdentity !== null
        && observed.startIdentity !== owner.startIdentity);
    if (!stale) return false;

    const quarantinePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(lockPath, quarantinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    await rm(quarantinePath, { recursive: true, force: true });
    return true;
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
    currentOwner: async () => ({
      pid: process.pid,
      startIdentity: await readProcessStartIdentity(process.pid)
        ?? `node-start-${Math.round(Date.now() - process.uptime() * 1_000)}`,
    }),
    inspectProcess: async (pid) => ({
      alive: isProcessAlive(pid),
      startIdentity: await readProcessStartIdentity(pid),
    }),
  };
}

async function readLockOwner(lockPath: string): Promise<RunnerReleaseLockOwner | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || !Number.isInteger((parsed as { pid?: unknown }).pid)
    || ((parsed as { pid: number }).pid <= 0)
    || typeof (parsed as { startIdentity?: unknown }).startIdentity !== "string"
    || !(parsed as { startIdentity: string }).startIdentity
  ) {
    return null;
  }
  return parsed as RunnerReleaseLockOwner;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime ? `linux-proc-${startTime}` : null;
  } catch {
    return null;
  }
}
