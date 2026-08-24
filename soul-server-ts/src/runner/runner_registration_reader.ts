import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { readClosedRunnerTailState } from "./closed_runner_tail_state.js";
import { runnerHostStatePath } from "./runner_host_state_store.js";
import {
  readAuthoritativeRunnerLifecycle,
  type AuthoritativeRunnerLifecycleOptions,
} from "./runner_lifecycle_reader.js";
import type { RunnerLifecycleRecord } from "./sqlite_runner_lifecycle.js";
import {
  readRunnerChildConfig,
  readRunnerPid,
  resolveRegisteredRunnerPid,
  type RunnerChildConfig,
} from "./runner_process_spawn.js";
import {
  inspectProcessIdentity,
  processStartIdentitiesMatch,
  type ProcessIdentity,
} from "./runner_process_lock.js";
import {
  runnerProcessPaths,
  type RunnerProcessPaths,
} from "./runner_process_paths.js";
import {
  readRunnerRegistrationIdentity,
  recoverRunnerDirectoryIdentity,
} from "./runner_registration_identity.js";
import type { RunnerRegistration } from "./runner_process_registry.js";

type RegistrationStage = "config" | "summary" | "identity" | "sqlite";

export async function readRunnerRegistrationSummary(
  directory: string,
  options: {
    verifyProcessIdentity?: boolean;
    inspectProcess?: (pid: number) => Promise<ProcessIdentity>;
  } & AuthoritativeRunnerLifecycleOptions = {},
): Promise<RunnerRegistration> {
  const configPath = resolve(directory, "runner-config.json");
  let config: RunnerChildConfig;
  try {
    config = await readRunnerChildConfig(configPath);
  } catch (error) {
    throw await annotateRegistrationError(directory, error, undefined, "config");
  }
  let configStat: Stats;
  try {
    const canonicalPaths = runnerProcessPaths(dirname(directory), config.sessionId);
    if (!samePaths(config.paths, canonicalPaths)) {
      throw new Error(`runner config paths mismatch: ${directory}`);
    }
    configStat = await stat(configPath);
  } catch (error) {
    throw await annotateRegistrationError(
      directory,
      error,
      { sessionId: config.sessionId, codeSha: config.codeSha },
      "summary",
    );
  }
  let identity: Awaited<ReturnType<typeof readRunnerRegistrationIdentity>>;
  try {
    identity = await readRunnerRegistrationIdentity(directory);
    if (
      identity
      && (identity.sessionId !== config.sessionId || identity.codeSha !== config.codeSha)
    ) {
      throw new Error(`runner identity does not match config: ${directory}`);
    }
  } catch (error) {
    throw await annotateRegistrationError(
      directory,
      error,
      { sessionId: config.sessionId, codeSha: config.codeSha },
      "identity",
    );
  }
  let databaseStat: Stats;
  let hostDatabaseStat: Stats | null;
  let hostDatabaseWalStat: Stats | null;
  let lifecycle: RunnerLifecycleRecord | null;
  let closedTailState: ReturnType<typeof readClosedRunnerTailState> | undefined;
  try {
    databaseStat = await stat(config.paths.databasePath);
    const hostDatabasePath = runnerHostStatePath(config.paths.databasePath);
    hostDatabaseStat = await statIfExists(hostDatabasePath);
    hostDatabaseWalStat = await statIfExists(`${hostDatabasePath}-wal`);
    lifecycle = await readAuthoritativeRunnerLifecycle(config.paths.databasePath, options);
    if (lifecycle && lifecycle.session_id !== config.sessionId) {
      throw new Error(`runner lifecycle summary session mismatch: ${directory}`);
    }
    closedTailState = lifecycle?.execution_state === "closed"
      ? readClosedRunnerTailState(config.paths.databasePath, config.sessionId)
      : undefined;
  } catch (error) {
    throw await annotateRegistrationError(
      directory,
      error,
      { sessionId: config.sessionId, codeSha: config.codeSha },
      "sqlite",
    );
  }
  try {
    const pid = resolveRegisteredRunnerPid(
      await readRunnerPid(config.paths.pidPath),
      lifecycle?.runner_pid ?? null,
      identity?.pid ?? null,
      directory,
      isPidAlive,
    );
    if (identity && identity.pid !== null && identity.pid !== pid) {
      throw new Error(`runner pid identity does not match registration: ${directory}`);
    }
    let pidAlive = pid !== null && isPidAlive(pid);
    if (options.verifyProcessIdentity && pid !== null && pidAlive) {
      const observed = await (options.inspectProcess ?? inspectProcessIdentity)(pid);
      pidAlive = observed.alive && (
        !identity?.startIdentity
        || observed.startIdentity === null
        || processStartIdentitiesMatch(observed.startIdentity, identity.startIdentity)
      );
    }
    return {
      config,
      pid,
      pidAlive,
      registeredAtMs: configStat.mtimeMs,
      bootstrap: null,
      lifecycle,
      registrationId: identity?.registrationId ?? null,
      pidStartIdentity: identity?.startIdentity ?? null,
      retiredAt: identity?.retiredAt ?? null,
      databaseMtimeMs: databaseStat.mtimeMs,
      databaseSize: databaseStat.size,
      hostDatabaseMtimeMs: hostDatabaseStat?.mtimeMs,
      hostDatabaseSize: hostDatabaseStat?.size,
      hostDatabaseWalMtimeMs: hostDatabaseWalStat?.mtimeMs,
      hostDatabaseWalSize: hostDatabaseWalStat?.size,
      ...(closedTailState ? { closedTailState } : {}),
    };
  } catch (error) {
    throw await annotateRegistrationError(
      directory,
      error,
      { sessionId: config.sessionId, codeSha: config.codeSha },
      "identity",
    );
  }
}

function samePaths(left: RunnerProcessPaths, right: RunnerProcessPaths): boolean {
  return left.sessionDirectory === right.sessionDirectory
    && left.databasePath === right.databasePath
    && left.socketPath === right.socketPath
    && left.pidPath === right.pidPath
    && left.lockPath === right.lockPath
    && left.configPath === right.configPath
    && left.logPath === right.logPath;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function statIfExists(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function annotateRegistrationError(
  directory: string,
  error: unknown,
  known?: { sessionId: string; codeSha?: string },
  stage?: RegistrationStage,
): Promise<Error> {
  const recovered = known ?? await recoverRunnerDirectoryIdentity(directory) ?? undefined;
  const normalized = (error instanceof Error ? error : new Error(String(error))) as Error & {
    runnerSessionId?: string;
    runnerCodeSha?: string;
    runnerRegistrationStage?: RegistrationStage;
  };
  if (recovered?.sessionId) normalized.runnerSessionId = recovered.sessionId;
  if (recovered?.codeSha) normalized.runnerCodeSha = recovered.codeSha;
  if (stage) normalized.runnerRegistrationStage = stage;
  return normalized;
}
