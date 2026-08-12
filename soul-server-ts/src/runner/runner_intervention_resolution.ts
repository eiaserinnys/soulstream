import { dirname, join, resolve } from "node:path";

import { openRunnerSqliteReadOnlyDatabase } from "./runner_sqlite_connection.js";
import { inspectProcessIdentity } from "./runner_process_lock.js";
import { readRunnerPid } from "./runner_process_spawn.js";
import { RunnerWriterLock } from "./runner_writer_lock.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import type { RunnerInterventionResolution } from "./sqlite_intervention_inbox.js";

export interface RunnerInterventionResolutionDependencies {
  acquireWriterLock(path: string): Promise<Pick<RunnerWriterLock, "release">>;
  inspectProcess: typeof inspectProcessIdentity;
  readPidFile: typeof readRunnerPid;
}

const defaultDependencies: RunnerInterventionResolutionDependencies = {
  acquireWriterLock: async (path) => await RunnerWriterLock.acquire(path),
  inspectProcess: inspectProcessIdentity,
  readPidFile: readRunnerPid,
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
    const databasePids = readRecordedRunnerPids(absoluteDatabasePath);
    const pidFilePid = await dependencies.readPidFile(join(sessionDirectory, "runner.pid"));
    const candidates = new Set<number>([
      ...databasePids,
      ...(pidFilePid === null ? [] : [pidFilePid]),
    ]);
    for (const pid of candidates) {
      const identity = await dependencies.inspectProcess(pid);
      if (identity.alive) {
        throw new Error(`runner intervention resolution requires a stopped runner: pid ${pid}`);
      }
    }

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

function readRecordedRunnerPids(databasePath: string): number[] {
  const database = openRunnerSqliteReadOnlyDatabase(databasePath);
  try {
    const rows = database.prepare(`
      SELECT runner_pid FROM runner_event_outbox
      WHERE record_kind = 'bootstrap' AND runner_pid IS NOT NULL
      UNION
      SELECT runner_pid FROM runner_prebootstrap_lifecycle
      WHERE singleton = 1
    `).all() as Array<{ runner_pid: number }>;
    return rows.map((row) => row.runner_pid);
  } finally {
    database.close();
  }
}
