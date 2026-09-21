import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const lockPath = join(
      this.options.lockRoot,
      `${createHash("sha256").update(key).digest("hex")}.lock`,
    );
    const deadline = Date.now() + this.options.defaultTimeoutMs;
    while (true) {
      try {
        mkdirSync(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new RepositoryLockError(`Repository lock timed out for ${key}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      key,
    }));

    let release = true;
    try {
      return await action();
    } catch (error) {
      if (error instanceof GitProcessError && !error.terminationConfirmed) {
        release = false;
      }
      throw error;
    } finally {
      if (release) rmSync(lockPath, { recursive: true, force: true });
    }
  }
}
