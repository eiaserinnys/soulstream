import { readAuthoritativeRunnerLifecycle } from "./runner_lifecycle_reader.js";
import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import {
  commandLineOwnedBySession,
  type RunnerProcessPaths,
} from "./runner_process_paths.js";
import {
  readRunnerPid,
  resolveRegisteredRunnerPid,
} from "./runner_process_registration.js";
import {
  readProcessCommandLine,
  type ProcessCommandLineProbe,
  type ProcessIdentity,
} from "./runner_process_lock.js";
import { readRunnerRegistrationIdentity } from "./runner_registration_identity.js";
import {
  invalidateRunnerRegistrationFilesLocked,
  removeRunnerRegistrationEvidenceForReplacementLocked,
} from "./runner_registration_mutation.js";
import { prepareRunnerWriterLockForSpawn } from "./runner_writer_lock.js";
import type { RunnerLifecycleRecord } from "./sqlite_runner_lifecycle.js";

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
  readLifecycle?(path: string): Promise<RunnerLifecycleRecord | null>;
  readCommandLine?(pid: number): Promise<ProcessCommandLineProbe>;
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
    && exactRunnerStartIdentitiesMatch(identity.startIdentity, expected.startIdentity)
    && (expected.registrationId === undefined
      || identity.registrationId === expected.registrationId);
  if (expected && !expectedOwnsIdentity) {
    await terminateExactRunner(expected, deps);
    return "registration_absent";
  }
  const owner = expected ?? exactOwner(identity, pid);
  if (pid !== null) {
    if (owner) {
      await terminateExactRunner(owner, deps);
    } else if (deps.isPidAlive(pid)) {
      await disposeUnprovenRunnerPid(pid, paths, deps);
    }
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

/**
 * Disposition of a live-looking pid that no registration identity vouches for.
 *
 * A liveness probe is not an identity. `process.kill(pid, 0)` answers "somebody
 * may hold this number" -- on Windows that is also true for a recycled pid and
 * for any process that denies access (measured on eias-linegames: 8 pids report
 * alive while absent from the process table, 2.76% pid occupancy). Promoting
 * that answer to a permanent failure is what made resume a fixed point: the
 * throw preceded the only branch that clears the residue, so every later resume
 * died identically.
 *
 * So the pid is disposed of by what the process *is*, never by its number:
 *
 *   proven ours  -> our orphan. Terminate it, then let the caller invalidate
 *                   the residue and spawn; no writer lock or named pipe of ours
 *                   survives to contend with the replacement.
 *   absent/other -> the number was recycled or never ours. Signal nothing and
 *                   let the caller isolate the residue: no runner holds this
 *                   session directory, so there is nothing to contend with.
 *   unavailable  -> unknown. Neither kill nor proceed -- keep failing closed.
 *
 * An identity-backed live runner never reaches here; its fail-closed proof in
 * `exactProcessIsAbsent` is unchanged.
 */
async function disposeUnprovenRunnerPid(
  pid: number,
  paths: RunnerProcessPaths,
  deps: RunnerProcessTerminationDependencies,
): Promise<void> {
  const probe = await (deps.readCommandLine ?? readProcessCommandLine)(pid);
  if (probe.kind === "unavailable") {
    throw identityProofFailure(
      `live runner has no exact identity and no readable command line: ${pid}`,
    );
  }
  if (probe.kind === "absent") return;
  if (!commandLineOwnedBySession(probe.value, paths)) return;
  await terminateSessionOwnedOrphan(pid, paths, deps);
}

async function terminateSessionOwnedOrphan(
  pid: number,
  paths: RunnerProcessPaths,
  deps: RunnerProcessTerminationDependencies,
): Promise<void> {
  signalRunnerProcess(pid, "SIGTERM", deps);
  if (await waitForSessionOwnedOrphanExit(pid, paths, deps)) return;
  signalRunnerProcess(pid, "SIGKILL", deps);
  if (await waitForSessionOwnedOrphanExit(pid, paths, deps)) return;
  throw new RunnerMutationFailure(
    "runner_termination_exit_proof_failed",
    `session-owned orphan runner remained live after SIGKILL: ${pid}`,
  );
}

async function waitForSessionOwnedOrphanExit(
  pid: number,
  paths: RunnerProcessPaths,
  deps: RunnerProcessTerminationDependencies,
): Promise<boolean> {
  const deadline = deps.now() + EXISTING_RUNNER_STOP_TIMEOUT_MS;
  while (deps.now() < deadline) {
    if (!deps.isPidAlive(pid)) return true;
    await deps.delay(25);
  }
  if (!deps.isPidAlive(pid)) return true;
  // The number can outlive our runner. Before calling this a failed kill, ask
  // the process itself once more -- an alive answer may already be a stranger.
  const probe = await (deps.readCommandLine ?? readProcessCommandLine)(pid);
  return probe.kind === "absent"
    || (probe.kind === "command_line" && !commandLineOwnedBySession(probe.value, paths));
}

export async function terminateExactRunner(
  expected: ExactRunnerProcess,
  deps: RunnerProcessTerminationDependencies,
): Promise<void> {
  if (await exactProcessIsAbsent(expected, deps, true)) return;
  signalRunnerProcess(expected.pid, "SIGTERM", deps);
  if (await waitForExactProcessExit(expected, deps, "SIGKILL")) return;
  signalRunnerProcess(expected.pid, "SIGKILL", deps);
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
    if (!deps.isPidAlive(expected.pid)) return true;
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
