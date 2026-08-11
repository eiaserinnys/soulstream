import { resolve } from "node:path";

import {
  ProcessOwnershipDirectoryLock,
  type ProcessOwnershipLockDependencies,
} from "./runner_process_lock.js";

const HOST_LOCK_TIMEOUT_MS = 0;

export function runnerStateHostLockPath(stateDirectory: string): string {
  return `${resolve(stateDirectory)}.host-lock`;
}

export class RunnerStateHostLock {
  private constructor(private readonly lock: ProcessOwnershipDirectoryLock) {}

  static async acquire(
    stateDirectory: string,
    deps?: ProcessOwnershipLockDependencies,
  ): Promise<RunnerStateHostLock> {
    const path = runnerStateHostLockPath(stateDirectory);
    const lock = await ProcessOwnershipDirectoryLock.acquire({
      path,
      timeoutMs: HOST_LOCK_TIMEOUT_MS,
      heldMessage: `runner state host ownership already held: ${path}`,
      ...(deps ? { deps } : {}),
    });
    return new RunnerStateHostLock(lock);
  }

  async release(): Promise<void> {
    await this.lock.release();
  }
}
