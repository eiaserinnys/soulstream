import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, unlink, type FileHandle } from "node:fs/promises";

import {
  defaultProcessOwnershipLockDependencies,
  isProvenStale,
  readProcessLockOwner,
  type ProcessLockOwner,
  type ProcessOwnershipLockDependencies,
} from "./runner_process_lock.js";

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
    const current = await readProcessLockOwner(this.path);
    if (current?.pid !== this.owner.pid || current.startIdentity !== this.owner.startIdentity) {
      throw new Error(`runner writer ownership changed before release: ${this.path}`);
    }
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.released = true;
  }
}

async function reclaimStaleWriterLock(
  path: string,
  deps: ProcessOwnershipLockDependencies,
): Promise<boolean> {
  const owner = await readWriterLockOwner(path);
  if (!owner) return false;
  const stale = owner.startIdentity === "legacy-pid-only"
    ? !(await deps.inspectProcess(owner.pid)).alive
    : await isProvenStale(owner, deps);
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
