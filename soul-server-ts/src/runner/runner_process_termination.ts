import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import type { RunnerProcessPaths } from "./runner_process_paths.js";
import { readRunnerRegistrationIdentity } from "./runner_registration_identity.js";
import { defaultProcessOwnershipLockDependencies } from "./runner_process_lock.js";
import {
  invalidateRunnerRegistrationFilesLocked,
  removeRunnerRegistrationEvidenceForReplacementLocked,
} from "./runner_registration_mutation.js";
import {
  inspectRunnerWriterLock,
  prepareRunnerWriterLockForSpawn,
  type RunnerWriterLockState,
} from "./runner_writer_lock.js";

const EXISTING_RUNNER_STOP_TIMEOUT_MS = 2_000;

export interface ExactRunnerProcess {
  registrationId?: string;
  pid: number;
  startIdentity: string;
}

export function exactRunnerStartIdentitiesMatch(left: string, right: string): boolean {
  return left === right;
}

export interface RunnerProcessTerminationDependencies {
  inspectProcess(pid: number): Promise<import("./runner_process_lock.js").ProcessIdentity>;
  inspectWriterLock?(path: string): Promise<RunnerWriterLockState>;
  signalPid(pid: number, signal: NodeJS.Signals): void;
  now(): number;
  delay(ms: number): Promise<void>;
}

export type RunnerTerminationOutcome =
  | "registration_invalidated"
  | "registration_absent";

export async function stopExistingRunnerLocked(
  paths: RunnerProcessPaths,
  deps: RunnerProcessTerminationDependencies,
  expected?: ExactRunnerProcess,
  cleanupMode: "strict" | "replacement" = "strict",
): Promise<RunnerTerminationOutcome> {
  const identity = await readRunnerRegistrationIdentity(paths.sessionDirectory);
  const expectedOwnsIdentity = expected !== undefined
    && identity?.pid === expected.pid
    && identity.startIdentity !== null
    && exactRunnerStartIdentitiesMatch(identity.startIdentity, expected.startIdentity)
    && (expected.registrationId === undefined
      || identity.registrationId === expected.registrationId);
  const lockState = await inspectRunnerLivenessLock(paths.lockPath, deps);
  if (expected && !expectedOwnsIdentity) {
    await terminateExactRunner(expected, deps, paths.lockPath, lockState);
    return "registration_absent";
  }
  if (lockState.kind === "unavailable") {
    if (!expected) {
      throw identityProofFailure(`runner writer lock ownership unavailable: ${paths.lockPath}`);
    }
    await terminateExactRunner(expected, deps, paths.lockPath, lockState);
  }
  if (lockState.kind === "held") {
    const owner = expected ?? lockState.owner;
    if (!sameExactRunner(owner, lockState.owner)) {
      throw identityProofFailure(`runner writer lock owner does not match registration: ${paths.lockPath}`);
    }
    await terminateExactRunner(owner, deps, paths.lockPath, lockState);
  }
  if (identity) {
    await invalidateRunnerRegistrationFilesLocked(
      paths,
      identity.registrationId,
      cleanupMode,
    );
    if (expected !== undefined) {
      await prepareRunnerWriterLockForSpawn(paths.lockPath);
    }
    return "registration_invalidated";
  }
  await removeRunnerRegistrationEvidenceForReplacementLocked(paths);
  return "registration_absent";
}

export async function terminateExactRunner(
  expected: ExactRunnerProcess,
  deps: RunnerProcessTerminationDependencies,
  lockPath: string,
  initialState?: RunnerWriterLockState,
): Promise<void> {
  if (await exactProcessIsAbsent(expected, lockPath, deps, initialState)) return;
  signalRunnerProcess(expected.pid, "SIGTERM", deps);
  if (await waitForExactProcessExit(expected, lockPath, deps, "SIGKILL")) return;
  signalRunnerProcess(expected.pid, "SIGKILL", deps);
  if (await waitForExactProcessExit(expected, lockPath, deps, "retirement")) return;
  throw new RunnerMutationFailure(
    "runner_termination_exit_proof_failed",
    `exact runner remained live after SIGKILL: ${expected.pid}`,
  );
}

async function waitForExactProcessExit(
  expected: ExactRunnerProcess,
  lockPath: string,
  deps: RunnerProcessTerminationDependencies,
  boundary: "SIGKILL" | "retirement",
): Promise<boolean> {
  const deadline = deps.now() + EXISTING_RUNNER_STOP_TIMEOUT_MS;
  while (deps.now() < deadline) {
    if (await exactProcessIsAbsent(
      expected,
      lockPath,
      deps,
      undefined,
      boundary,
      true,
    )) return true;
    await deps.delay(25);
  }
  return await exactProcessIsAbsent(expected, lockPath, deps, undefined, boundary);
}

async function exactProcessIsAbsent(
  expected: ExactRunnerProcess,
  lockPath: string,
  deps: RunnerProcessTerminationDependencies,
  initialState?: RunnerWriterLockState,
  boundary: "SIGTERM" | "SIGKILL" | "retirement" = "SIGTERM",
  retryUnavailable = false,
): Promise<boolean> {
  const state = initialState ?? await inspectRunnerLivenessLock(lockPath, deps);
  if (state.kind === "free") return true;
  if (state.kind === "unavailable") {
    // RunnerWriterLock.release removes its owner record before closing the
    // kernel endpoint. An exact pre-close proof still authorizes this one
    // process, so confirm its current start identity before signalling it.
    // Without that proof stopExistingRunnerLocked fails closed above.
    if (retryUnavailable) return false;
    const observed = await deps.inspectProcess(expected.pid);
    if (!observed.alive) return true;
    if (observed.startIdentity === null) {
      throw identityProofFailure(`runner writer lock ownership unavailable: ${lockPath}`);
    }
    return !exactRunnerStartIdentitiesMatch(observed.startIdentity, expected.startIdentity);
  }
  if (sameExactRunner(state.owner, expected)) return false;
  throw identityProofFailure(`runner writer lock owner changed before ${boundary}: ${lockPath}`);
}

export async function inspectRunnerLivenessLock(
  path: string,
  deps: RunnerProcessTerminationDependencies,
): Promise<RunnerWriterLockState> {
  if (deps.inspectWriterLock) return await deps.inspectWriterLock(path);
  const defaults = defaultProcessOwnershipLockDependencies();
  return await inspectRunnerWriterLock(path, {
    now: deps.now,
    delay: deps.delay,
    currentOwner: defaults.currentOwner,
    inspectProcess: deps.inspectProcess,
  });
}

function sameExactRunner(left: ExactRunnerProcess, right: ExactRunnerProcess): boolean {
  return left.pid === right.pid
    && exactRunnerStartIdentitiesMatch(left.startIdentity, right.startIdentity);
}

function signalRunnerProcess(
  pid: number,
  signal: NodeJS.Signals,
  deps: RunnerProcessTerminationDependencies,
): void {
  try {
    deps.signalPid(pid, signal);
  } catch (error) {
    throw new RunnerMutationFailure(
      "runner_termination_signal_failed",
      `${signal} failed for exact runner ${pid}`,
      { cause: error },
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
