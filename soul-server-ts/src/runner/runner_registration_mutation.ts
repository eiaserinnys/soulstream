import { unlink } from "node:fs/promises";

import type { RunnerProcessPaths } from "./runner_process_paths.js";
import {
  invalidateRunnerRegistrationIdentity,
  retireTerminalRunnerRegistrationIdentity,
} from "./runner_registration_identity.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";

export async function invalidateRunnerRegistrationFiles(
  paths: RunnerProcessPaths,
  expectedRegistrationId: string | null,
): Promise<void> {
  await withRunnerSessionMutationLock(paths.sessionDirectory, async () => {
    await invalidateRunnerRegistrationIdentity(
      paths.sessionDirectory,
      expectedRegistrationId,
    );
    await unlinkIfPresent(paths.pidPath);
    await unlinkIfPresent(paths.socketPath);
  });
}

export async function retireTerminalRunnerRegistrationFiles(
  paths: RunnerProcessPaths,
  expectedRegistrationId: string | null,
  retiredAt: Date,
): Promise<void> {
  await withRunnerSessionMutationLock(paths.sessionDirectory, async () => {
    await retireTerminalRunnerRegistrationIdentity(
      paths.sessionDirectory,
      expectedRegistrationId,
      retiredAt,
    );
    await unlinkIfPresent(paths.pidPath);
    await unlinkIfPresent(paths.socketPath);
  });
}

export async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
