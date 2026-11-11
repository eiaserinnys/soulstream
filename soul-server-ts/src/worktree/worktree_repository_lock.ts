import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GitProcessError } from "./worktree_process.js";

export class RepositoryLockError extends Error {
  readonly code = "REPOSITORY_LOCK_TIMEOUT";
}

export class RepositoryLock {
  constructor(private readonly options: {
    lockRoot: string;
    defaultTimeoutMs: number;
  }) {
    mkdirSync(options.lockRoot, { recursive: true });
  }

  /**
   * Every acquire, owner write, and release is async: on a slow disk a single
   * mkdir in the lock root has taken seconds, and sync calls held the event loop.
   */
  async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const lockPath = join(
      this.options.lockRoot,
      `${createHash("sha256").update(key).digest("hex")}.lock`,
    );
    const deadline = Date.now() + this.options.defaultTimeoutMs;
    while (true) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await reclaimDeadLock(lockPath, key)) continue;
        if (Date.now() >= deadline) {
          throw new RepositoryLockError(`Repository lock timed out for ${key}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      key,
    }));

    let release = true;
    try {
      return await action();
    } catch (error) {
      if (hasUnconfirmedProcess(error)) {
        release = false;
        await writeFile(join(lockPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          key,
          unconfirmedChild: true,
        }));
      }
      throw error;
    } finally {
      if (release) await rm(lockPath, { recursive: true, force: true });
    }
  }
}

function hasUnconfirmedProcess(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof GitProcessError && !current.terminationConfirmed) return true;
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return false;
}

async function reclaimDeadLock(lockPath: string, key: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
      pid?: unknown;
      key?: unknown;
      unconfirmedChild?: unknown;
    };
    if (
      owner.key !== key
      || typeof owner.pid !== "number"
      || !Number.isSafeInteger(owner.pid)
      || owner.pid <= 0
      || owner.unconfirmedChild === true
      || processIsAlive(owner.pid)
    ) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
