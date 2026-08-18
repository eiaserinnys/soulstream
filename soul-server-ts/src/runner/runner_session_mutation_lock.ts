import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { RunnerWriterLock } from "./runner_writer_lock.js";

const tails = new Map<string, Promise<void>>();

/**
 * Serializes destructive host-side mutations for one session directory.
 * The in-memory tail is only a same-process optimization. The sibling owner
 * file is the restart-safe fence and is published through the writer lock's
 * complete-record bootstrap protocol.
 */
export async function withRunnerSessionMutationLock<T>(
  sessionDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(sessionDirectory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(sessionDirectory, tail);
  await previous;
  let lock: RunnerWriterLock | undefined;
  try {
    await mkdir(dirname(sessionDirectory), { recursive: true, mode: 0o700 });
    lock = await RunnerWriterLock.acquire(runnerSessionMutationLockPath(sessionDirectory));
    return await operation();
  } finally {
    await lock?.release();
    release();
    if (tails.get(sessionDirectory) === tail) tails.delete(sessionDirectory);
  }
}

export function runnerSessionMutationLockPath(sessionDirectory: string): string {
  return `${sessionDirectory}.mutation-owner`;
}
