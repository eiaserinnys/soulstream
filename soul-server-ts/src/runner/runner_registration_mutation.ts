import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rmdir, unlink } from "node:fs/promises";

import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import type { RunnerProcessPaths } from "./runner_process_paths.js";
import {
  readRunnerRegistrationIdentity,
  type RunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "./runner_registration_identity.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";

export interface RunnerRegistrationMutationDependencies {
  writeRegistrationIdentity(
    sessionDirectory: string,
    identity: RunnerRegistrationIdentity,
  ): Promise<void>;
}

const defaultMutationDependencies: RunnerRegistrationMutationDependencies = {
  writeRegistrationIdentity: async (sessionDirectory, identity) =>
    await writeRunnerRegistrationIdentity(sessionDirectory, identity),
};

export async function invalidateRunnerRegistrationFiles(
  paths: RunnerProcessPaths,
  expectedRegistrationId: string | null,
): Promise<void> {
  await withRunnerSessionMutationLock(paths.sessionDirectory, async () => {
    await invalidateRunnerRegistrationFilesLocked(paths, expectedRegistrationId, "strict");
  });
}

export async function invalidateRunnerRegistrationFilesLocked(
  paths: RunnerProcessPaths,
  expectedRegistrationId: string | null,
  cleanupMode: "strict" | "replacement" = "strict",
  dependencies: RunnerRegistrationMutationDependencies = defaultMutationDependencies,
): Promise<void> {
  const current = await requireRegistrationIdentity(paths, expectedRegistrationId);
  await mutateRegistrationFiles(
    paths,
    { ...current, pid: null, startIdentity: null },
    cleanupMode,
    dependencies,
  );
}

export async function retireTerminalRunnerRegistrationFiles(
  paths: RunnerProcessPaths,
  expectedRegistrationId: string | null,
  retiredAt: Date,
  dependencies: RunnerRegistrationMutationDependencies = defaultMutationDependencies,
): Promise<void> {
  await withRunnerSessionMutationLock(paths.sessionDirectory, async () => {
    await retireTerminalRunnerRegistrationFilesLocked(
      paths,
      expectedRegistrationId,
      retiredAt,
      "strict",
      dependencies,
    );
  });
}

export async function retireTerminalRunnerRegistrationFilesLocked(
  paths: RunnerProcessPaths,
  expectedRegistrationId: string | null,
  retiredAt: Date,
  cleanupMode: "strict" | "replacement" = "strict",
  dependencies: RunnerRegistrationMutationDependencies = defaultMutationDependencies,
): Promise<void> {
  const current = await requireRegistrationIdentity(paths, expectedRegistrationId);
  await mutateRegistrationFiles(
    paths,
    {
      ...current,
      pid: null,
      startIdentity: null,
      retiredAt: retiredAt.toISOString(),
    },
    cleanupMode,
    dependencies,
  );
}

export async function removeRunnerRegistrationEvidenceForReplacementLocked(
  paths: RunnerProcessPaths,
): Promise<void> {
  await mutateEvidenceFiles(paths, "replacement", async () => {});
}

export async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function requireRegistrationIdentity(
  paths: RunnerProcessPaths,
  expectedRegistrationId: string | null,
): Promise<RunnerRegistrationIdentity> {
  const current = await readRunnerRegistrationIdentity(paths.sessionDirectory);
  if (!current || expectedRegistrationId === null
    || current.registrationId !== expectedRegistrationId) {
    throw new RunnerMutationFailure(
      "runner_registration_identity_proof_failed",
      `registration changed before mutation: ${paths.sessionDirectory}`,
    );
  }
  return current;
}

async function mutateRegistrationFiles(
  paths: RunnerProcessPaths,
  nextIdentity: RunnerRegistrationIdentity,
  cleanupMode: "strict" | "replacement",
  dependencies: RunnerRegistrationMutationDependencies,
): Promise<void> {
  await mutateEvidenceFiles(paths, cleanupMode, async () => {
    await dependencies.writeRegistrationIdentity(paths.sessionDirectory, nextIdentity);
  });
}

interface EvidenceSnapshot {
  path: string;
  kind: "absent" | "directory" | "entry";
}

interface QuarantinedEvidence extends EvidenceSnapshot {
  quarantinePath: string;
}

async function mutateEvidenceFiles(
  paths: RunnerProcessPaths,
  cleanupMode: "strict" | "replacement",
  commit: () => Promise<void>,
): Promise<void> {
  const snapshots = await Promise.all([
    snapshotEvidence(paths.pidPath, cleanupMode),
    snapshotEvidence(paths.socketPath, cleanupMode),
  ]);
  const quarantined: QuarantinedEvidence[] = [];
  try {
    for (const snapshot of snapshots) {
      if (snapshot.kind === "absent") continue;
      const quarantinePath = `${snapshot.path}.mutation-${process.pid}-${randomUUID()}`;
      await rename(snapshot.path, quarantinePath);
      quarantined.push({ ...snapshot, quarantinePath });
    }
  } catch (error) {
    await rollbackEvidenceOrThrow(paths, error, quarantined);
  }
  try {
    await commit();
  } catch (error) {
    await rollbackEvidenceOrThrow(paths, error, quarantined);
  }
  try {
    for (const snapshot of quarantined) await removeQuarantinedEvidence(snapshot);
  } catch (error) {
    throw new RunnerMutationFailure(
      "runner_registration_persistence_failed",
      `quarantined registration evidence could not be removed: ${paths.sessionDirectory}`,
      { cause: error },
    );
  }
}

async function snapshotEvidence(
  path: string,
  cleanupMode: "strict" | "replacement",
): Promise<EvidenceSnapshot> {
  try {
    const stats = await lstat(path);
    if (stats.isDirectory()) {
      if (cleanupMode === "strict") {
        throw new Error(`runner evidence is not a file: ${path}`);
      }
      if ((await readdir(path)).length > 0) {
        throw new Error(`runner evidence directory is not empty: ${path}`);
      }
      return { path, kind: "directory" };
    }
    return { path, kind: "entry" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, kind: "absent" };
    if (error instanceof RunnerMutationFailure) throw error;
    throw new RunnerMutationFailure(
      "runner_registration_persistence_failed",
      `could not snapshot registration evidence: ${path}`,
      { cause: error },
    );
  }
}

async function rollbackEvidenceOrThrow(
  paths: RunnerProcessPaths,
  originalError: unknown,
  quarantined: QuarantinedEvidence[],
): Promise<never> {
  const restoreErrors: unknown[] = [];
  for (const snapshot of quarantined.reverse()) {
    try {
      await rename(snapshot.quarantinePath, snapshot.path);
    } catch (restoreError) {
      restoreErrors.push(restoreError);
    }
  }
  const cause = restoreErrors.length === 0
    ? originalError
    : new AggregateError(
        [originalError, ...restoreErrors],
        "runner evidence rollback failed",
      );
  throw new RunnerMutationFailure(
    "runner_registration_persistence_failed",
    `registration files were not committed: ${paths.sessionDirectory}`,
    { cause },
  );
}

async function removeQuarantinedEvidence(snapshot: QuarantinedEvidence): Promise<void> {
  if (snapshot.kind === "directory") await rmdir(snapshot.quarantinePath);
  else await unlink(snapshot.quarantinePath);
}
