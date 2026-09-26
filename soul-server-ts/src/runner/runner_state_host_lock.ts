import { resolve } from "node:path";

import { RunnerKernelLock } from "./runner_kernel_lock.js";

export function runnerStateHostLockPath(stateDirectory: string): string {
  return `${resolve(stateDirectory)}.host-lock`;
}

export class RunnerStateHostLock {
  private constructor(private readonly lock: RunnerKernelLock) {}

  static async acquire(stateDirectory: string): Promise<RunnerStateHostLock> {
    const path = runnerStateHostLockPath(stateDirectory);
    const lock = await RunnerKernelLock.tryAcquire(path);
    if (!lock) {
      throw new Error(`runner state host ownership already held: ${path}`);
    }
    return new RunnerStateHostLock(lock);
  }

  async release(): Promise<void> {
    await this.lock.release();
  }
}
