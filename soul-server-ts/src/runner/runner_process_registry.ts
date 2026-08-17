import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { Logger } from "pino";

import {
  readClosedRunnerTailState,
  type ClosedRunnerTailState,
} from "./closed_runner_tail_state.js";
import {
  RunnerSqliteEventOutbox,
  type RunnerBootstrapRecord,
} from "./sqlite_event_outbox.js";
import { RunnerParentOutbox } from "./runner_parent_outbox.js";
import {
  readRunnerHostAcknowledgedThrough,
  runnerHostStatePath,
} from "./runner_host_state_store.js";
import {
  readAuthoritativeRunnerLifecycle,
  type AuthoritativeRunnerLifecycleOptions,
} from "./runner_lifecycle_reader.js";
import {
  readRunnerSqliteLifecycle,
  type RunnerLifecycleRecord,
} from "./sqlite_runner_lifecycle.js";
import {
  readRunnerChildConfig,
  readRunnerPid,
  resolveRegisteredRunnerPid,
  type RunnerChildConfig,
} from "./runner_process_spawn.js";
import { inspectProcessIdentity, type ProcessIdentity } from "./runner_process_lock.js";
import {
  readRunnerRegistrationIdentity,
  recoverRunnerDirectoryIdentity,
} from "./runner_registration_identity.js";

export interface RunnerRegistration {
  config: RunnerChildConfig;
  pid: number | null;
  pidAlive: boolean;
  registeredAtMs: number;
  bootstrap: RunnerBootstrapRecord | null;
  lifecycle: RunnerLifecycleRecord | null;
  registrationId?: string | null;
  pidStartIdentity?: string | null;
  databaseMtimeMs?: number;
  databaseSize?: number;
  hostDatabaseMtimeMs?: number;
  hostDatabaseSize?: number;
  hostDatabaseWalMtimeMs?: number;
  hostDatabaseWalSize?: number;
  closedTailState?: ClosedRunnerTailState;
}

export interface RunnerRegistrationScan {
  registrations: RunnerRegistration[];
  errors: Array<{ directory: string; error: Error; sessionId?: string; codeSha?: string }>;
}

export interface RunnerDurableInspection {
  registration: RunnerRegistration;
  acknowledgedThrough: number | null;
  latestDurableSourceSeq: number | null;
  incompleteDurableWork: boolean;
  durableRecordCount: number;
  unacknowledgedIpcFrameCount: number;
  pendingInterventionCount: number;
}

export type RunnerRecoveryDisposition =
  | "wait_for_bootstrap"
  | "adopt_prebootstrap"
  | "adopt_running"
  | "replay_terminal"
  | "reap_dead"
  | "reap_stalled"
  | "already_reaped"
  | "closed";

export function isTerminalRunnerExecutionState(
  state: RunnerLifecycleRecord["execution_state"],
): boolean {
  return state === "completed"
    || state === "failed"
    || state === "reaped"
    || state === "closed";
}

export interface LiveRunnerSessionIdsOptions {
  stateDirectory: string;
  leaseTimeoutMs: number;
  scan?: typeof scanRunnerRegistrations;
  now?: () => number;
  onScanError?: (failure: RunnerRegistrationScan["errors"][number]) => void;
  logger?: Pick<Logger, "info">;
}

const RUNNER_TOOL_LEASE_MULTIPLIER = 2;

export async function scanRunnerRegistrations(
  stateDirectory: string,
  options: {
    verifyProcessIdentity?: boolean;
    inspectProcess?: (pid: number) => Promise<ProcessIdentity>;
  } & AuthoritativeRunnerLifecycleOptions = {},
): Promise<RunnerRegistrationScan> {
  const registrations: RunnerRegistration[] = [];
  const errors: RunnerRegistrationScan["errors"] = [];
  let entries;
  try {
    entries = await readdir(stateDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { registrations, errors };
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = resolve(stateDirectory, entry.name);
    try {
      registrations.push(await readRunnerRegistrationSummary(directory, options));
    } catch (error) {
      const normalized = asError(error);
      const sessionId = (normalized as Error & { runnerSessionId?: unknown }).runnerSessionId;
      const codeSha = (normalized as Error & { runnerCodeSha?: unknown }).runnerCodeSha;
      errors.push({
        directory,
        error: normalized,
        ...(typeof sessionId === "string" && sessionId ? { sessionId } : {}),
        ...(typeof codeSha === "string" && codeSha ? { codeSha } : {}),
      });
    }
  }
  return { registrations, errors };
}

export function classifyRunnerRegistration(
  registration: RunnerRegistration,
  nowMs: number,
  leaseTimeoutMs: number,
): RunnerRecoveryDisposition {
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(leaseTimeoutMs)
    || leaseTimeoutMs <= 0) {
    throw new Error("runner recovery clock and lease timeout must be positive");
  }
  const lifecycle = registration.lifecycle;
  if (lifecycle?.execution_state === "reaped") return "already_reaped";
  if (lifecycle?.execution_state === "closed") return "closed";
  if (!lifecycle) {
    if (nowMs - registration.registeredAtMs < leaseTimeoutMs) {
      return registration.pidAlive ? "adopt_prebootstrap" : "wait_for_bootstrap";
    }
    return registration.pidAlive ? "reap_stalled" : "reap_dead";
  }
  if (isTerminalRunnerExecutionState(lifecycle.execution_state)) return "replay_terminal";
  if (!registration.pidAlive) return "reap_dead";
  const progressedAt = Date.parse(lifecycle.progress_at);
  if (!Number.isFinite(progressedAt)) {
    throw new Error(`runner lifecycle progress timestamp invalid: ${lifecycle.progress_at}`);
  }
  if (lifecycle.in_flight_tools.length > 0) {
    const toolLeaseTimeoutMs = runnerToolLeaseTimeoutMs(
      leaseTimeoutMs,
      registration.config.claudeRuntimeTurnTimeoutMs,
    );
    for (const tool of lifecycle.in_flight_tools) {
      const startedAt = Date.parse(tool.started_at);
      if (!Number.isFinite(startedAt)) {
        throw new Error(`runner tool lease timestamp invalid: ${tool.started_at}`);
      }
      // The finite cap is absolute: later progress cannot renew an existing
      // tool identity once its first observed start has expired.
      if (nowMs - startedAt >= toolLeaseTimeoutMs) return "reap_stalled";
    }
  }
  if (nowMs - progressedAt < leaseTimeoutMs) return "adopt_running";
  if (lifecycle.in_flight_tools.length === 0) return "reap_stalled";
  const livenessAt = Date.parse(lifecycle.liveness_at);
  if (!Number.isFinite(livenessAt)) {
    throw new Error(`runner lifecycle liveness timestamp invalid: ${lifecycle.liveness_at}`);
  }
  return nowMs - livenessAt < leaseTimeoutMs ? "adopt_running" : "reap_stalled";
}

/**
 * Twice the configured turn ceiling preserves the longest supported tool call
 * with one full turn of safety margin. A larger runner lease receives the same
 * margin. Missing tool_result events still expire at the resulting finite cap.
 */
export function runnerToolLeaseTimeoutMs(
  leaseTimeoutMs: number,
  turnTimeoutMs: number,
): number {
  if (!Number.isSafeInteger(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
    throw new Error("runner lease timeout must be a positive integer");
  }
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs <= 0) {
    throw new Error("runner turn timeout must be a positive integer");
  }
  const scaled = Math.max(leaseTimeoutMs, turnTimeoutMs)
    * RUNNER_TOOL_LEASE_MULTIPLIER;
  if (!Number.isSafeInteger(scaled)) {
    throw new Error("runner tool lease timeout exceeds safe integer range");
  }
  return scaled;
}

/**
 * Returns the durable runner inventory that is safe to advertise as running.
 * A damaged registration with an independently recovered session identity is
 * retained conservatively in the positive inventory. If any directory has no
 * recoverable identity, the entire inventory is rejected so callers retry
 * instead of advertising a dangerous partial view.
 */
export async function listLiveRunnerSessionIds(
  options: LiveRunnerSessionIdsOptions,
): Promise<string[]> {
  const result = await (options.scan ?? scanRunnerRegistrations)(options.stateDirectory);
  const errors: RunnerRegistrationScan["errors"] = [];
  const disappearedDirectories: string[] = [];
  for (const failure of result.errors) {
    if (await pathIsAbsent(failure.directory)) {
      disappearedDirectories.push(failure.directory);
    } else {
      errors.push(failure);
    }
  }
  if (disappearedDirectories.length > 0) {
    disappearedDirectories.sort();
    options.logger?.info(
      { count: disappearedDirectories.length, directories: disappearedDirectories },
      "skipped runner inventory entries removed during scan",
    );
  }
  for (const failure of errors) options.onScanError?.(failure);
  const unidentified = errors.filter((failure) => !failure.sessionId);
  if (unidentified.length > 0) {
    throw new Error(
      `runner inventory incomplete: identity unavailable for ${unidentified
        .map((failure) => failure.directory)
        .sort()
        .join(", ")}`,
      { cause: new AggregateError(unidentified.map((failure) => failure.error)) },
    );
  }
  const nowMs = (options.now ?? Date.now)();
  const sessionIds = new Set<string>();
  for (const failure of errors) {
    if (failure.sessionId) sessionIds.add(failure.sessionId);
  }
  for (const registration of result.registrations) {
    const disposition = classifyRunnerRegistration(
      registration,
      nowMs,
      options.leaseTimeoutMs,
    );
    if (disposition === "adopt_prebootstrap" || disposition === "adopt_running") {
      sessionIds.add(registration.config.sessionId);
    }
  }
  return [...sessionIds].sort();
}

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
  try {
    if (resolve(config.paths.sessionDirectory) !== directory) {
      throw new Error(`runner config directory mismatch: ${directory}`);
    }
    const configStat = await stat(configPath);
    const databaseStat = await stat(config.paths.databasePath);
    const hostDatabasePath = runnerHostStatePath(config.paths.databasePath);
    const hostDatabaseStat = await statIfExists(hostDatabasePath);
    const hostDatabaseWalStat = await statIfExists(`${hostDatabasePath}-wal`);
    const identity = await readRunnerRegistrationIdentity(directory);
    if (
      identity
      && (identity.sessionId !== config.sessionId || identity.codeSha !== config.codeSha)
    ) {
      throw new Error(`runner identity does not match config: ${directory}`);
    }
    const lifecycle = await readAuthoritativeRunnerLifecycle(config.paths.databasePath, options);
    if (lifecycle && lifecycle.session_id !== config.sessionId) {
      throw new Error(`runner lifecycle summary session mismatch: ${directory}`);
    }
    const pid = resolveRegisteredRunnerPid(
      await readRunnerPid(config.paths.pidPath),
      lifecycle?.runner_pid ?? null,
      identity?.pid ?? null,
      directory,
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
        || observed.startIdentity === identity.startIdentity
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
      databaseMtimeMs: databaseStat.mtimeMs,
      databaseSize: databaseStat.size,
      hostDatabaseMtimeMs: hostDatabaseStat?.mtimeMs,
      hostDatabaseSize: hostDatabaseStat?.size,
      hostDatabaseWalMtimeMs: hostDatabaseWalStat?.mtimeMs,
      hostDatabaseWalSize: hostDatabaseWalStat?.size,
      ...(lifecycle?.execution_state === "closed"
        ? { closedTailState: readClosedRunnerTailState(config.paths.databasePath, config.sessionId) }
        : {}),
    };
  } catch (error) {
    throw await annotateRegistrationError(
      directory,
      error,
      { sessionId: config.sessionId, codeSha: config.codeSha },
      "summary",
    );
  }
}

export async function readRunnerRegistrationForDeletion(
  directory: string,
): Promise<RunnerRegistration> {
  return await readRunnerRegistrationSummary(directory, { verifyProcessIdentity: true });
}

export function runnerReleaseGcCandidateFingerprint(scan: RunnerRegistrationScan): string {
  return JSON.stringify({
    candidates: scan.registrations.filter(isReleaseGcCandidate).map((registration) => ({
      directory: registration.config.paths.sessionDirectory,
      sessionId: registration.config.sessionId,
      codeSha: registration.config.codeSha,
      registrationId: registration.registrationId ?? null,
      pid: registration.pid,
      pidStartIdentity: registration.pidStartIdentity ?? null,
      pidAlive: registration.pidAlive,
      databaseMtimeMs: registration.databaseMtimeMs ?? null,
      databaseSize: registration.databaseSize ?? null,
      hostDatabaseMtimeMs: registration.hostDatabaseMtimeMs ?? null,
      hostDatabaseSize: registration.hostDatabaseSize ?? null,
      hostDatabaseWalMtimeMs: registration.hostDatabaseWalMtimeMs ?? null,
      hostDatabaseWalSize: registration.hostDatabaseWalSize ?? null,
      lifecycleState: registration.lifecycle?.execution_state ?? null,
      lifecycleProgressSeq: registration.lifecycle?.progress_seq ?? null,
      lifecycleProgressAt: registration.lifecycle?.progress_at ?? null,
      lifecycleLivenessAt: registration.lifecycle?.liveness_at ?? null,
      lifecycleInFlightTools: registration.lifecycle?.in_flight_tools ?? [],
    })).sort((left, right) => left.directory.localeCompare(right.directory)),
    errors: scan.errors.map((failure) => ({
      directory: failure.directory,
      sessionId: failure.sessionId ?? null,
      codeSha: failure.codeSha ?? null,
      message: failure.error.message,
    })).sort((left, right) => left.directory.localeCompare(right.directory)),
  });
}

function isReleaseGcCandidate(registration: RunnerRegistration): boolean {
  return registration.pid !== null
    && !registration.pidAlive
    && registration.lifecycle !== null
    && registration.lifecycle.execution_state !== "running";
}

export async function hydrateRunnerRegistration(
  registration: RunnerRegistration,
): Promise<RunnerRegistration> {
  const outbox = await RunnerParentOutbox.open(
    registration.config.paths.databasePath,
    registration.config.sessionId,
  );
  let bootstrap: RunnerBootstrapRecord | null;
  try {
    bootstrap = await outbox.readBootstrap();
  } finally {
    outbox.close();
  }
  const lifecycle = readRunnerSqliteLifecycle(registration.config.paths.databasePath);
  return { ...registration, bootstrap, lifecycle };
}

export async function inspectRunnerDurableState(
  registration: RunnerRegistration,
): Promise<RunnerDurableInspection> {
  const outbox = await RunnerSqliteEventOutbox.openReadOnly(
    registration.config.paths.databasePath,
    { sessionId: registration.config.sessionId },
  );
  const lifecycle = readRunnerSqliteLifecycle(registration.config.paths.databasePath);
  let bootstrap: RunnerBootstrapRecord | null;
  let acknowledgedThrough: number | null = null;
  let latestDurableSourceSeq: number | null = null;
  let incompleteDurableWork: boolean;
  let evidence!: ReturnType<RunnerSqliteEventOutbox["inspectPendingDurableEvidence"]>;
  try {
    evidence = outbox.inspectPendingDurableEvidence();
    bootstrap = await outbox.readBootstrap();
    if (!bootstrap) {
      incompleteDurableWork = true;
    } else {
      latestDurableSourceSeq = outbox.latestDurableSourceSeq();
      acknowledgedThrough = readRunnerHostAcknowledgedThrough(
        runnerHostStatePath(registration.config.paths.databasePath),
        bootstrap.stream_id,
        bootstrap.session_id,
      );
      incompleteDurableWork = acknowledgedThrough === null
        || acknowledgedThrough !== latestDurableSourceSeq
        || await outbox.hasPendingDurableWork(acknowledgedThrough);
    }
  } finally {
    outbox.close();
  }
  return {
    registration: { ...registration, bootstrap, lifecycle },
    acknowledgedThrough,
    latestDurableSourceSeq,
    incompleteDurableWork,
    ...evidence,
  };
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

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function annotateRegistrationError(
  directory: string,
  error: unknown,
  known?: { sessionId: string; codeSha?: string },
  stage?: "config" | "summary",
): Promise<Error> {
  const recovered = known ?? await recoverRunnerDirectoryIdentity(directory) ?? undefined;
  const normalized = asError(error) as Error & {
    runnerSessionId?: string;
    runnerCodeSha?: string;
    runnerRegistrationStage?: "config" | "summary";
  };
  if (recovered?.sessionId) normalized.runnerSessionId = recovered.sessionId;
  if (recovered?.codeSha) normalized.runnerCodeSha = recovered.codeSha;
  if (stage) normalized.runnerRegistrationStage = stage;
  return normalized;
}
