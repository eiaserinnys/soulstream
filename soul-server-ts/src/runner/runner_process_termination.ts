import { RunnerMutationFailure } from "./runner_mutation_failure.js";
import { terminateWindowsProcessTree } from "../process/terminate_windows_process_tree.js";
import { randomUUID } from "node:crypto";
import { closeCommandFrame } from "./frame_protocol.js";
import { connectRunnerSocket } from "./runner_socket_endpoint.js";
import type { RunnerProcessPaths } from "./runner_process_paths.js";
import { readRunnerRegistrationIdentity } from "./runner_registration_identity.js";
import {
  defaultProcessOwnershipLockDependencies,
  processStartIdentitiesMatch,
} from "./runner_process_lock.js";
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
  return processStartIdentitiesMatch(left, right);
}

export interface RunnerProcessTerminationDependencies {
  inspectProcess(pid: number): Promise<import("./runner_process_lock.js").ProcessIdentity>;
  inspectWriterLock?(path: string): Promise<RunnerWriterLockState>;
  signalPid(pid: number, signal: NodeJS.Signals): void;
  now(): number;
  delay(ms: number): Promise<void>;
  platform?: NodeJS.Platform;
  terminateProcessTree?(pid: number): Promise<void>;
  requestShutdown?(socketPath: string): Promise<void>;
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
    await terminateExactRunner(expected, deps, paths.lockPath, lockState, paths.socketPath);
    return "registration_absent";
  }
  if (lockState.kind === "unavailable") {
    if (!expected) {
      throw identityProofFailure(`runner writer lock ownership unavailable: ${paths.lockPath}`);
    }
    await terminateRegisteredRunnerDuringLockRelease(
      expected,
      deps,
      paths.lockPath,
      lockState,
      paths.socketPath,
    );
  }
  if (lockState.kind === "held") {
    const owner = expected ?? lockState.owner;
    if (!sameExactRunner(owner, lockState.owner)) {
      throw identityProofFailure(`runner writer lock owner does not match registration: ${paths.lockPath}`);
    }
    await terminateExactRunner(owner, deps, paths.lockPath, lockState, paths.socketPath);
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
  socketPath?: string,
): Promise<void> {
  return await terminateExactRunnerWithPolicy(
    expected,
    deps,
    lockPath,
    initialState,
    false,
    socketPath,
  );
}

async function terminateRegisteredRunnerDuringLockRelease(
  expected: ExactRunnerProcess,
  deps: RunnerProcessTerminationDependencies,
  lockPath: string,
  initialState: RunnerWriterLockState,
  socketPath: string,
): Promise<void> {
  return await terminateExactRunnerWithPolicy(
    expected,
    deps,
    lockPath,
    initialState,
    true,
    socketPath,
  );
}

async function terminateExactRunnerWithPolicy(
  expected: ExactRunnerProcess,
  deps: RunnerProcessTerminationDependencies,
  lockPath: string,
  initialState: RunnerWriterLockState | undefined,
  acceptRegisteredReleaseGap: boolean,
  socketPath?: string,
): Promise<void> {
  if ((deps.platform ?? process.platform) === "win32") {
    if (await exactProcessIsAbsent(
      expected,
      lockPath,
      deps,
      initialState,
      "retirement",
      false,
      acceptRegisteredReleaseGap,
    )) return;
    if (socketPath) {
      try {
        await (deps.requestShutdown ?? requestRunnerShutdown)(socketPath);
      } catch {
        // The child may already be closing its IPC endpoint; taskkill remains
        // the final Windows process-tree cleanup after the graceful window.
      }
    }
    if (await waitForExactProcessExit(
      expected,
      lockPath,
      deps,
      "retirement",
      acceptRegisteredReleaseGap,
    )) return;
    const terminateProcessTree = deps.terminateProcessTree ?? terminateWindowsProcessTree;
    await terminateProcessTree(expected.pid);
    if (await waitForExactProcessExit(
      expected,
      lockPath,
      deps,
      "retirement",
      acceptRegisteredReleaseGap,
    )) return;
    throw new RunnerMutationFailure(
      "runner_termination_exit_proof_failed",
      `exact runner remained live after Windows process-tree termination: ${expected.pid}`,
    );
  }
  if (await exactProcessIsAbsent(
    expected,
    lockPath,
    deps,
    initialState,
    "SIGTERM",
    false,
    acceptRegisteredReleaseGap,
  )) return;
  signalRunnerProcess(expected.pid, "SIGTERM", deps);
  if (await waitForExactProcessExit(expected, lockPath, deps, "SIGKILL")) return;
  signalRunnerProcess(expected.pid, "SIGKILL", deps);
  if (await waitForExactProcessExit(expected, lockPath, deps, "retirement")) return;
  throw new RunnerMutationFailure(
    "runner_termination_exit_proof_failed",
    `exact runner remained live after SIGKILL: ${expected.pid}`,
  );
}

async function requestRunnerShutdown(socketPath: string): Promise<void> {
  const connection = await connectRunnerSocket(socketPath, {
    timeoutMs: 1_000,
    deadlineMs: 1_000,
  });
  try {
    const result = await connection.request(
      closeCommandFrame(`windows-shutdown:${randomUUID()}`),
      { timeoutMs: 1_000 },
    );
    if (result.kind !== "command_result" || result.result.status !== "ok") {
      throw new Error("runner IPC shutdown request was not acknowledged");
    }
  } finally {
    connection.close();
  }
}

async function waitForExactProcessExit(
  expected: ExactRunnerProcess,
  lockPath: string,
  deps: RunnerProcessTerminationDependencies,
  boundary: "SIGKILL" | "retirement",
  acceptRegisteredReleaseGap = false,
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
      acceptRegisteredReleaseGap,
    )) return true;
    await deps.delay(25);
  }
  return await exactProcessIsAbsent(
    expected,
    lockPath,
    deps,
    undefined,
    boundary,
    false,
    acceptRegisteredReleaseGap,
  );
}

async function exactProcessIsAbsent(
  expected: ExactRunnerProcess,
  lockPath: string,
  deps: RunnerProcessTerminationDependencies,
  initialState?: RunnerWriterLockState,
  boundary: "SIGTERM" | "SIGKILL" | "retirement" = "SIGTERM",
  retryUnavailable = false,
  acceptRegisteredReleaseGap = false,
): Promise<boolean> {
  const state = initialState ?? await inspectRunnerLivenessLock(lockPath, deps);
  if (state.kind === "free") return true;
  if (state.kind === "unavailable") {
    // RunnerWriterLock.release removes its owner record before closing the
    // kernel endpoint. An exact pre-close proof still authorizes this one
    // process, so confirm its current start identity before signalling it.
    // Without that proof stopExistingRunnerLocked fails closed above.
    if (retryUnavailable) return false;
    if (!acceptRegisteredReleaseGap) {
      throw identityProofFailure(`runner writer lock ownership unavailable: ${lockPath}`);
    }
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
