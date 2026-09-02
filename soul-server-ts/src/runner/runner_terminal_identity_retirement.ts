import type { RunnerProcessPaths } from "./runner_process_paths.js";
import {
  type RunnerProcessTerminationDependencies,
  inspectRunnerLivenessLock,
} from "./runner_process_termination.js";
import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import { readRunnerRegistrationIdentity } from "./runner_registration_identity.js";
import {
  removeRunnerRegistrationEvidenceForReplacementLocked,
  retireTerminalRunnerRegistrationFilesLocked,
} from "./runner_registration_mutation.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";
import { prepareRunnerWriterLockForSpawn } from "./runner_writer_lock.js";

export interface ReleasedTerminalExecutionEvidence {
  paths: RunnerProcessPaths;
  registrationId: string | null;
}

export async function retireReleasedTerminalExecutionEvidence(
  input: ReleasedTerminalExecutionEvidence,
  confirmRetirementStillValid: () => Promise<boolean>,
  deps: RunnerProcessTerminationDependencies,
): Promise<void> {
  const { paths } = input;
  await withRunnerSessionMutationLock(paths.sessionDirectory, async () => {
    const identity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
    if (
      (identity === null) !== (input.registrationId === null)
      || (identity && identity.registrationId !== input.registrationId)
    ) {
      throw identityProofFailure(
        `runner registration changed before released terminal retirement: ${paths.sessionDirectory}`,
      );
    }
    if (identity && (identity.pid !== null || identity.startIdentity !== null)) {
      throw identityProofFailure(
        `runner process identity appeared before released terminal retirement: ${paths.sessionDirectory}`,
      );
    }
    const lockState = await inspectRunnerLivenessLock(paths.lockPath, deps);
    if (lockState.kind !== "free") {
      throw identityProofFailure(
        `runner lock is not free before released terminal retirement: ${paths.sessionDirectory}`,
      );
    }
    await requireRetirementStillValid(paths, confirmRetirementStillValid);
    await prepareRunnerWriterLockForSpawn(paths.lockPath);
    if (input.registrationId === null) {
      await removeRunnerRegistrationEvidenceForReplacementLocked(paths);
      return;
    }
    await retireTerminalRunnerRegistrationFilesLocked(
      paths,
      input.registrationId,
      new Date(deps.now()),
    );
  });
}

async function requireRetirementStillValid(
  paths: RunnerProcessPaths,
  confirmRetirementStillValid: () => Promise<boolean>,
): Promise<void> {
  if (!await confirmRetirementStillValid()) {
    throw new Error(
      `released terminal retirement is no longer valid: ${paths.sessionDirectory}`,
    );
  }
}

function identityProofFailure(message: string, cause?: unknown): RunnerMutationFailure {
  return new RunnerMutationFailure(
    "runner_registration_identity_proof_failed",
    message,
    cause === undefined ? undefined : { cause },
  );
}
