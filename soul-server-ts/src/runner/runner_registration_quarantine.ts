import { randomUUID } from "node:crypto";
import { access, mkdir, rename } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  defaultProcessOwnershipLockDependencies,
  type ProcessIdentity,
} from "./runner_process_lock.js";
import {
  readRunnerRegistrationSummary,
  type RunnerRegistrationScan,
} from "./runner_process_registry.js";
import { readRunnerPid } from "./runner_process_spawn.js";
import { readRunnerRegistrationIdentity } from "./runner_registration_identity.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";
import {
  inspectRunnerWriterLock,
  type RunnerWriterLockState,
} from "./runner_writer_lock.js";

type RegistrationFailure = RunnerRegistrationScan["errors"][number];

export const RUNNER_REGISTRATION_QUARANTINE_STAGES = [
  "config",
  "summary",
  "identity",
  "sqlite",
] as const;
type RunnerRegistrationQuarantineStage =
  (typeof RUNNER_REGISTRATION_QUARANTINE_STAGES)[number];

export type RunnerRegistrationQuarantineResult =
  | { status: "quarantined"; path: string; pid: number | null }
  | {
    status: "retained";
    reason:
      | "unsupported_failure_stage"
      | "registration_recovered"
      | "runner_alive";
  }
  | { status: "missing" };

export async function quarantineUnreadableRunnerRegistration(
  stateDirectory: string,
  failure: RegistrationFailure,
  dependencies: {
    inspectProcess?: (pid: number) => Promise<ProcessIdentity>;
    inspectWriterLock?: (path: string) => Promise<RunnerWriterLockState>;
    now?: () => number;
  } = {},
): Promise<RunnerRegistrationQuarantineResult> {
  assertDirectChild(stateDirectory, failure.directory);
  if (!RUNNER_REGISTRATION_QUARANTINE_STAGES.includes(
    registrationFailureStage(failure.error) as RunnerRegistrationQuarantineStage,
  )) {
    return { status: "retained", reason: "unsupported_failure_stage" };
  }
  return await withRunnerSessionMutationLock(failure.directory, async () => {
    if (!await exists(failure.directory)) return { status: "missing" };
    try {
      await readRunnerRegistrationSummary(failure.directory, {
        verifyProcessIdentity: true,
        ...(dependencies.inspectProcess
          ? { inspectProcess: dependencies.inspectProcess }
          : {}),
        ...(dependencies.inspectWriterLock
          ? { inspectWriterLock: dependencies.inspectWriterLock }
          : {}),
      });
      return { status: "retained", reason: "registration_recovered" };
    } catch {
      // The same config is still unreadable under the session mutation lock.
    }

    const defaults = defaultProcessOwnershipLockDependencies();
    const observed = await (dependencies.inspectWriterLock ?? (async (path: string) =>
      await inspectRunnerWriterLock(path, {
        ...defaults,
        ...(dependencies.inspectProcess ? { inspectProcess: dependencies.inspectProcess } : {}),
      })))(join(failure.directory, "runner.lock"));
    if (observed.kind !== "free") return { status: "retained", reason: "runner_alive" };
    const identity = await readIdentityIfValid(failure.directory);
    const pid = identity?.pid ?? await readPidIfValid(join(failure.directory, "runner.pid"));

    const quarantineRoot = `${resolve(stateDirectory)}.quarantine`;
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
    const target = join(
      quarantineRoot,
      `${basename(failure.directory)}-${(dependencies.now ?? Date.now)()}-${randomUUID()}`,
    );
    try {
      await rename(failure.directory, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      throw error;
    }
    return { status: "quarantined", path: target, pid };
  });
}

function registrationFailureStage(error: Error): RunnerRegistrationQuarantineStage | undefined {
  return (error as Error & { runnerRegistrationStage?: RunnerRegistrationQuarantineStage })
    .runnerRegistrationStage;
}

async function readIdentityIfValid(directory: string) {
  try {
    return await readRunnerRegistrationIdentity(directory);
  } catch {
    return null;
  }
}

async function readPidIfValid(path: string): Promise<number | null> {
  try {
    return await readRunnerPid(path);
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertDirectChild(stateDirectory: string, directory: string): void {
  const state = resolve(stateDirectory);
  const target = resolve(directory);
  const pathFromState = relative(state, target);
  if (!pathFromState || pathFromState.startsWith("..") || dirname(target) !== state) {
    throw new Error(`runner quarantine target is not a direct state child: ${directory}`);
  }
}
