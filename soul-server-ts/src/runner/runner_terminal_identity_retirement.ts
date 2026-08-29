import { readRunnerPid } from "./runner_process_registration.js";
import type { RunnerProcessPaths } from "./runner_process_paths.js";
import {
  type ExactRunnerProcess,
  type RunnerProcessTerminationDependencies,
  exactRunnerStartIdentitiesMatch,
  terminateExactRunner,
} from "./runner_process_termination.js";
import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import { readRunnerRegistrationIdentity } from "./runner_registration_identity.js";
import {
  removeRunnerRegistrationEvidenceForReplacementLocked,
  retireTerminalRunnerRegistrationFilesLocked,
} from "./runner_registration_mutation.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";
import { prepareRunnerWriterLockForSpawn } from "./runner_writer_lock.js";

export interface TerminalExecutionOwnershipIdentity extends ExactRunnerProcess {
  registrationId: string;
}

export interface TerminalExecutionOwnershipRetirement
  extends TerminalExecutionOwnershipIdentity {
  paths: RunnerProcessPaths;
}

export async function retireTerminalExecutionIdentity(
  input: TerminalExecutionOwnershipRetirement,
  commitOwnership: () => Promise<boolean>,
  deps: RunnerProcessTerminationDependencies,
): Promise<void> {
  const { paths, ...expected } = input;
  await withRunnerSessionMutationLock(paths.sessionDirectory, async () => {
    const identity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
    if (!identity) {
      await retireAbsentIdentity(paths, expected, commitOwnership, deps);
      return;
    }
    if (identity.registrationId !== expected.registrationId) {
      throw identityProofFailure(
        `runner registration changed before ownership retirement: ${paths.sessionDirectory}`,
      );
    }
    if (
      identity.pid === null
      || identity.startIdentity === null
      || identity.pid !== expected.pid
      || !exactRunnerStartIdentitiesMatch(identity.startIdentity, expected.startIdentity)
    ) {
      throw identityProofFailure(
        `runner process identity changed before ownership retirement: ${paths.sessionDirectory}`,
      );
    }
    const pidEvidence = await readRunnerPid(paths.pidPath);
    if (pidEvidence !== null && pidEvidence !== expected.pid) {
      throw identityProofFailure(
        `runner pid evidence changed before ownership retirement: ${paths.sessionDirectory}`,
      );
    }

    // Destructive termination only accepts the exact canonical identity token.
    // Cross-format timestamp tolerance is observation-only and never authorizes a signal.
    await terminateExactRunner(expected, deps);
    await prepareRunnerWriterLockForSpawn(paths.lockPath);
    await requireCentralCommit(paths, commitOwnership);
    await retireTerminalRunnerRegistrationFilesLocked(
      paths,
      expected.registrationId,
      new Date(deps.now()),
    );
  });
}

async function retireAbsentIdentity(
  paths: RunnerProcessPaths,
  expected: TerminalExecutionOwnershipIdentity,
  commitOwnership: () => Promise<boolean>,
  deps: RunnerProcessTerminationDependencies,
): Promise<void> {
  let expectedProcessAbsent = !deps.isPidAlive(expected.pid);
  if (!expectedProcessAbsent) {
    const observed = await deps.inspectProcess(expected.pid).catch((error: unknown) => {
      throw identityProofFailure(
        `could not inspect runner pid ${expected.pid} before ownership retirement`,
        error,
      );
    });
    expectedProcessAbsent = !observed.alive
      ? !deps.isPidAlive(expected.pid)
      : observed.startIdentity !== null
        && !exactRunnerStartIdentitiesMatch(observed.startIdentity, expected.startIdentity);
  }
  if (!expectedProcessAbsent) {
    throw identityProofFailure(
      `live exact runner has no registration before ownership retirement: ${paths.sessionDirectory}`,
    );
  }
  await prepareRunnerWriterLockForSpawn(paths.lockPath);
  await requireCentralCommit(paths, commitOwnership);
  await removeRunnerRegistrationEvidenceForReplacementLocked(paths);
}

async function requireCentralCommit(
  paths: RunnerProcessPaths,
  commitOwnership: () => Promise<boolean>,
): Promise<void> {
  if (!await commitOwnership()) {
    throw new Error(
      `terminal execution ownership changed before retirement: ${paths.sessionDirectory}`,
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
