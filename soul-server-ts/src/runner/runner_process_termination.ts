import { readAuthoritativeRunnerLifecycle } from "./runner_lifecycle_reader.js";
import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import type { RunnerProcessPaths } from "./runner_process_paths.js";
import {
  readRunnerPid,
  resolveRegisteredRunnerPid,
} from "./runner_process_registration.js";
import type { ProcessIdentity } from "./runner_process_lock.js";
import { processStartIdentitiesMatch } from "./runner_process_lock.js";
import { readRunnerRegistrationIdentity } from "./runner_registration_identity.js";
import {
  invalidateRunnerRegistrationFilesLocked,
  removeRunnerRegistrationEvidenceForReplacementLocked,
} from "./runner_registration_mutation.js";
import type { RunnerLifecycleRecord } from "./sqlite_runner_lifecycle.js";

const EXISTING_RUNNER_STOP_TIMEOUT_MS = 2_000;

export interface ExactRunnerProcess {
  pid: number;
  startIdentity: string;
}

export interface RunnerProcessTerminationDependencies {
  inspectProcess(pid: number): Promise<ProcessIdentity>;
  isPidAlive(pid: number): boolean;
  signalPid(pid: number, signal: NodeJS.Signals): void;
  now(): number;
  delay(ms: number): Promise<void>;
  readLifecycle?(path: string): Promise<RunnerLifecycleRecord | null>;
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
  const lifecycle = await (deps.readLifecycle ?? readAuthoritativeRunnerLifecycle)(
    paths.databasePath,
  );
  const pid = expected?.pid ?? resolveRegisteredRunnerPid(
    pidFilePid,
    lifecycle?.runner_pid ?? null,
    identity?.pid ?? null,
    paths.sessionDirectory,
    deps.isPidAlive,
  );
  const expectedOwnsIdentity = expected !== undefined
    && identity?.pid === expected.pid
    && identity.startIdentity !== null
    && processStartIdentitiesMatch(identity.startIdentity, expected.startIdentity);
  if (expected && !expectedOwnsIdentity) {
    throw identityProofFailure(
      `registration changed before exact termination: ${paths.sessionDirectory}`,
    );
  }
  const owner = expected ?? exactOwner(identity, pid);
  if (pid !== null) {
    if (owner) {
      await terminateExactRunner(owner, deps);
    } else if (deps.isPidAlive(pid)) {
      throw identityProofFailure(`live runner has no exact identity: ${pid}`);
    }
  }
  if (identity) {
    await invalidateRunnerRegistrationFilesLocked(
      paths,
      identity.registrationId,
      cleanupMode,
    );
    return "registration_invalidated";
  }
  await removeRunnerRegistrationEvidenceForReplacementLocked(paths);
  return "registration_absent";
}

export async function terminateExactRunner(
  expected: ExactRunnerProcess,
  deps: RunnerProcessTerminationDependencies,
): Promise<void> {
  if (await exactProcessIsAbsent(expected, deps, true)) return;
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
  if (processStartIdentitiesMatch(observed.startIdentity, expected.startIdentity)) {
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

function exactOwner(
  identity: Awaited<ReturnType<typeof readRunnerRegistrationIdentity>>,
  pid: number | null,
): ExactRunnerProcess | undefined {
  if (pid === null || identity?.pid !== pid || identity.startIdentity === null) {
    return undefined;
  }
  return { pid, startIdentity: identity.startIdentity };
}

function identityProofFailure(message: string, cause?: unknown): RunnerMutationFailure {
  return new RunnerMutationFailure(
    "runner_registration_identity_proof_failed",
    message,
    cause === undefined ? undefined : { cause },
  );
}
