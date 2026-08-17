import { randomUUID } from "node:crypto";
import { access, open, readFile, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import {
  defaultProcessOwnershipLockDependencies,
  isProvenStale,
  readProcessLockOwner,
  type ProcessLockOwner,
  type ProcessOwnershipLockDependencies,
} from "./runner_process_lock.js";

const activeWriterOwners = new Map<string, ProcessLockOwner>();

export class RunnerWriterLock {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly handle: FileHandle,
    private readonly owner: ProcessLockOwner,
  ) {}

  static async acquire(
    path: string,
    deps: ProcessOwnershipLockDependencies = defaultProcessOwnershipLockDependencies(),
  ): Promise<RunnerWriterLock> {
    while (true) {
      let handle: FileHandle;
      try {
        handle = await open(path, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await reclaimStaleWriterLock(path, deps)) continue;
        throw new Error(`runner writer lock already held: ${path}`);
      }
      const owner = await deps.currentOwner();
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`);
        await handle.sync();
        activeWriterOwners.set(resolve(path), owner);
        return new RunnerWriterLock(path, handle, owner);
      } catch (error) {
        await handle.close();
        await unlink(path).catch(() => {});
        throw error;
      }
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    await this.handle.close();
    try {
      const current = await readProcessLockOwner(this.path);
      if (!sameOwner(current, this.owner)) {
        throw new Error(`runner writer ownership changed before release: ${this.path}`);
      }
      try {
        await unlink(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } finally {
      if (sameOwner(activeWriterOwners.get(resolve(this.path)) ?? null, this.owner)) {
        activeWriterOwners.delete(resolve(this.path));
      }
      this.released = true;
    }
  }
}

/**
 * Clears only a proven stale or current-process orphan before child spawn.
 * A live child owner and a host lock with a live in-process object stay fenced.
 */
export async function prepareRunnerWriterLockForSpawn(
  path: string,
  deps: ProcessOwnershipLockDependencies = defaultProcessOwnershipLockDependencies(),
): Promise<boolean> {
  if (!await pathExists(path)) return false;
  if (await reclaimStaleWriterLock(path, deps)) return true;
  throw new Error(`runner writer lock already held: ${path}`);
}

async function reclaimStaleWriterLock(
  path: string,
  deps: ProcessOwnershipLockDependencies,
): Promise<boolean> {
  const owner = await readWriterLockOwner(path);
  if (!owner) return false;
  const activeOwner = activeWriterOwners.get(resolve(path));
  if (sameOwner(activeOwner ?? null, owner)) return false;
  const currentOwner = await deps.currentOwner();
  const orphanedCurrentOwner = sameOwner(currentOwner, owner);
  const stale = orphanedCurrentOwner || (owner.startIdentity === "legacy-pid-only"
    ? !(await deps.inspectProcess(owner.pid)).alive
    : await isProvenStale(owner, deps));
  if (!stale) return false;
  const quarantinePath = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  await rm(quarantinePath, { force: true });
  return true;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sameOwner(left: ProcessLockOwner | null, right: ProcessLockOwner): boolean {
  return left?.pid === right.pid && left.startIdentity === right.startIdentity;
}

async function readWriterLockOwner(path: string): Promise<ProcessLockOwner | null> {
  const owner = await readProcessLockOwner(path);
  if (owner) return owner;

  // A pre-fence runner wrote only its pid. It is reclaimable only when that pid
  // is proven dead; a live or reused pid remains fail-closed.
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return { pid, startIdentity: "legacy-pid-only" };
  } catch {
    return null;
  }
}
