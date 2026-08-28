import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";

import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import type { RunnerProcessPaths } from "./runner_process_paths.js";
import {
  readRunnerRegistrationIdentity,
  type RunnerRegistrationIdentity,
  writeRunnerRegistrationIdentity,
} from "./runner_registration_identity.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";

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
): Promise<void> {
  const current = await requireRegistrationIdentity(paths, expectedRegistrationId);
  await mutateRegistrationFiles(
    paths,
    { ...current, pid: null, startIdentity: null },
    cleanupMode,
  );
}

export async function retireTerminalRunnerRegistrationFiles(
  paths: RunnerProcessPaths,
  expectedRegistrationId: string | null,
  retiredAt: Date,
): Promise<void> {
  await withRunnerSessionMutationLock(paths.sessionDirectory, async () => {
    await retireTerminalRunnerRegistrationFilesLocked(
      paths,
      expectedRegistrationId,
      retiredAt,
    );
  });
}

export async function retireTerminalRunnerRegistrationFilesLocked(
  paths: RunnerProcessPaths,
  expectedRegistrationId: string | null,
  retiredAt: Date,
  cleanupMode: "strict" | "replacement" = "strict",
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
): Promise<void> {
  await mutateEvidenceFiles(paths, cleanupMode, async () => {
    await writeRunnerRegistrationIdentity(paths.sessionDirectory, nextIdentity);
  });
}

interface EvidenceSnapshot {
  path: string;
  kind: "absent" | "file" | "directory" | "other";
  contents?: Buffer;
  mode?: number;
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
  const removed: EvidenceSnapshot[] = [];
  try {
    for (const snapshot of snapshots) {
      if (snapshot.kind === "absent") continue;
      if (snapshot.kind === "directory") await rmdir(snapshot.path);
      else await unlink(snapshot.path);
      removed.push(snapshot);
    }
    await commit();
  } catch (error) {
    const restoreErrors: unknown[] = [];
    for (const snapshot of removed.reverse()) {
      try {
        await restoreEvidence(snapshot);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    const cause = restoreErrors.length === 0
      ? error
      : new AggregateError([error, ...restoreErrors], "runner evidence rollback failed");
    throw new RunnerMutationFailure(
      "runner_registration_persistence_failed",
      `registration files were not committed: ${paths.sessionDirectory}`,
      { cause },
    );
  }
}

async function snapshotEvidence(
  path: string,
  cleanupMode: "strict" | "replacement",
): Promise<EvidenceSnapshot> {
  try {
    const stats = await lstat(path);
    if (stats.isFile()) {
      return { path, kind: "file", contents: await readFile(path), mode: stats.mode & 0o777 };
    }
    if (stats.isDirectory()) {
      if (cleanupMode === "strict") {
        throw new Error(`runner evidence is not a file: ${path}`);
      }
      if ((await readdir(path)).length > 0) {
        throw new Error(`runner evidence directory is not empty: ${path}`);
      }
      return { path, kind: "directory", mode: stats.mode & 0o777 };
    }
    return { path, kind: "other" };
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

async function restoreEvidence(snapshot: EvidenceSnapshot): Promise<void> {
  if (snapshot.kind === "file") {
    await writeFile(snapshot.path, snapshot.contents!, { mode: snapshot.mode });
    return;
  }
  if (snapshot.kind === "directory") {
    await mkdir(snapshot.path, { mode: snapshot.mode });
    return;
  }
  if (snapshot.kind === "other") {
    throw new Error(`non-file runner evidence cannot be restored: ${snapshot.path}`);
  }
}
