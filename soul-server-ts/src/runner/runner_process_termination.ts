import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import type { RunnerProcessPaths } from "./runner_process_paths.js";
import { readRunnerPid } from "./runner_process_registration.js";
import type { ProcessIdentity } from "./runner_process_lock.js";
import { readRunnerRegistrationIdentity } from "./runner_registration_identity.js";
import { invalidateRunnerRegistrationFilesLocked } from "./runner_registration_mutation.js";
import { prepareRunnerWriterLockForSpawn } from "./runner_writer_lock.js";

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
  inspectProcess(pid: number): Promise<ProcessIdentity>;
  isPidAlive(pid: number): boolean;
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
  const pidFilePid = await readPidEvidence(paths.pidPath, identity, cleanupMode);
  if (
    cleanupMode === "strict"
    && identity?.pid !== null
    && identity?.pid !== undefined
    && pidFilePid !== null
    && pidFilePid !== identity.pid
  ) {
    throw identityProofFailure(
      `runner pid evidence changed before cleanup: ${paths.sessionDirectory}`,
    );
  }
  const expectedOwnsIdentity = expected !== undefined
    && identity?.pid === expected.pid
    && identity.startIdentity !== null
    && exactRunnerStartIdentitiesMatch(identity.startIdentity, expected.startIdentity)
    && (expected.registrationId === undefined
      || identity.registrationId === expected.registrationId);
  if (expected && !expectedOwnsIdentity) {
    await terminateExactRunner(expected, deps);
    return "registration_absent";
  }
  if (!identity || identity.pid === null || identity.startIdentity === null) {
    return "registration_absent";
  }
  await terminateExactRunner(
    expected ?? { pid: identity.pid, startIdentity: identity.startIdentity },
    deps,
    cleanupMode === "replacement",
  );
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

export async function terminateExactRunner(
  expected: ExactRunnerProcess,
  deps: RunnerProcessTerminationDependencies,
  mismatchIsAbsence = true,
): Promise<void> {
  if (await exactProcessIsAbsent(expected, deps, mismatchIsAbsence)) return;
  signalExactProcess(expected, "SIGTERM", deps);
  if (await waitForExactProcessExit(expected, deps, "SIGKILL")) return;
  signalExactProcess(expected, "SIGKILL", deps);
  if (await waitForExactProcessExit(expected, deps, "retirement")) return;
  throw new RunnerMutationFailure(
    "runner_termination_exit_proof_failed",
    `exact runner remained live after SIGKILL: ${expected.pid}`,
  );
}

async function waitForExactProcessExit(
  expected: ExactRunnerProcess,
  deps: RunnerProcessTerminationDependencies,
  boundary: "SIGKILL" | "retirement",
): Promise<boolean> {
  const deadline = deps.now() + EXISTING_RUNNER_STOP_TIMEOUT_MS;
  while (deps.now() < deadline) {
    if (await exactProcessIsAbsent(expected, deps, false, boundary)) return true;
    await deps.delay(25);
  }
  return await exactProcessIsAbsent(expected, deps, false, boundary);
}

async function exactProcessIsAbsent(
  expected: ExactRunnerProcess,
  deps: RunnerProcessTerminationDependencies,
  mismatchIsAbsence: boolean,
  boundary: "SIGTERM" | "SIGKILL" | "retirement" = "SIGTERM",
): Promise<boolean> {
  if (!deps.isPidAlive(expected.pid)) return true;
  let observed: ProcessIdentity;
  try {
    observed = await deps.inspectProcess(expected.pid);
  } catch (error) {
    throw identityProofFailure(`could not inspect runner pid ${expected.pid}`, error);
  }
  if (!observed.alive) {
    return !deps.isPidAlive(expected.pid);
  }
  if (observed.startIdentity === null) {
    throw identityProofFailure(`live runner start identity unavailable: ${expected.pid}`);
  }
  if (exactRunnerStartIdentitiesMatch(observed.startIdentity, expected.startIdentity)) {
    return false;
  }
  if (mismatchIsAbsence) return true;
  throw identityProofFailure(
    `runner process identity changed before ${boundary}: ${expected.pid}`,
  );
}

function signalExactProcess(
  expected: ExactRunnerProcess,
  signal: NodeJS.Signals,
  deps: RunnerProcessTerminationDependencies,
): void {
  try {
    deps.signalPid(expected.pid, signal);
  } catch (error) {
    throw new RunnerMutationFailure(
      "runner_termination_signal_failed",
      `${signal} failed for exact runner ${expected.pid}`,
      { cause: error },
    );
  }
}

async function readPidEvidence(
  path: string,
  identity: Awaited<ReturnType<typeof readRunnerRegistrationIdentity>>,
  cleanupMode: "strict" | "replacement",
): Promise<number | null> {
  try {
    return await readRunnerPid(path);
  } catch (error) {
    if (cleanupMode === "replacement" && identity !== null && identity.pid !== null) {
      return null;
    }
    throw new RunnerMutationFailure(
      "runner_registration_persistence_failed",
      `runner pid evidence is unreadable: ${path}`,
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
