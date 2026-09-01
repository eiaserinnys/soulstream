import { dirname, join, resolve } from "node:path";

import { RunnerWriterLock } from "./runner_writer_lock.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import type { RunnerInterventionResolution } from "./sqlite_intervention_inbox.js";

export interface RunnerInterventionResolutionDependencies {
  acquireWriterLock(path: string): Promise<Pick<RunnerWriterLock, "release">>;
}

const defaultDependencies: RunnerInterventionResolutionDependencies = {
  acquireWriterLock: async (path) => await RunnerWriterLock.acquire(path),
};

export async function resolveAmbiguousRunnerIntervention(
  databasePath: string,
  interventionId: string,
  resolution: RunnerInterventionResolution,
  dependencies: RunnerInterventionResolutionDependencies = defaultDependencies,
): Promise<{
  databasePath: string;
  interventionId: string;
  resolution: RunnerInterventionResolution;
}> {
  const absoluteDatabasePath = resolve(databasePath);
  const sessionDirectory = dirname(absoluteDatabasePath);
  const writerLock = await dependencies.acquireWriterLock(join(sessionDirectory, "runner.lock"));
  try {
    const outbox = await RunnerSqliteEventOutbox.open(absoluteDatabasePath);
    try {
      await outbox.resolveAmbiguousIntervention(interventionId, resolution);
    } finally {
      outbox.close();
    }
    return { databasePath: absoluteDatabasePath, interventionId, resolution };
  } finally {
    await writerLock.release();
  }
}
