import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { RunnerWriterLock } from "./runner_writer_lock.js";
import type { RunnerPhaseObservation } from "./runner_phase_observation.js";

const tails = new Map<string, Promise<void>>();

export interface RunnerSessionMutationLockObservationContext {
  phaseObservation: RunnerPhaseObservation;
  sessionId: string;
}

/**
 * Serializes destructive host-side mutations for one session directory.
 * The in-memory tail is only a same-process optimization. The sibling owner
 * file is the restart-safe fence and is published through the writer lock's
 * complete-record bootstrap protocol.
 */
export async function withRunnerSessionMutationLock<T>(
  sessionDirectory: string,
  operation: () => Promise<T>,
  observationContext?: RunnerSessionMutationLockObservationContext,
): Promise<T> {
  const previous = tails.get(sessionDirectory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(sessionDirectory, tail);
  if (observationContext) {
    await observationContext.phaseObservation.runAsync(
      "mutationQueueWait",
      { sessionId: observationContext.sessionId },
      () => previous,
    );
  } else {
    await previous;
  }
  let lock: RunnerWriterLock | undefined;
  try {
    if (observationContext) {
      lock = await observationContext.phaseObservation.runAsync(
        "mutationAcquire",
        { sessionId: observationContext.sessionId },
        async () => {
          await mkdir(dirname(sessionDirectory), { recursive: true, mode: 0o700 });
          return await RunnerWriterLock.acquire(runnerSessionMutationLockPath(sessionDirectory));
        },
      );
    } else {
      await mkdir(dirname(sessionDirectory), { recursive: true, mode: 0o700 });
      lock = await RunnerWriterLock.acquire(runnerSessionMutationLockPath(sessionDirectory));
    }
    return await operation();
  } finally {
    if (lock) {
      if (observationContext) {
        await observationContext.phaseObservation.runAsync(
          "mutationRelease",
          { sessionId: observationContext.sessionId },
          async () => await lock!.release(),
        );
      } else {
        await lock.release();
      }
    }
    release();
    if (tails.get(sessionDirectory) === tail) tails.delete(sessionDirectory);
  }
}

export function runnerSessionMutationLockPath(sessionDirectory: string): string {
  return `${sessionDirectory}.mutation-owner`;
}
