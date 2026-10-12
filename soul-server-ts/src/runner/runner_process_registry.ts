import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { Logger } from "pino";

import type { ClosedRunnerTailState } from "./closed_runner_tail_state.js";
import {
  RunnerSqliteEventOutbox,
  type RunnerBootstrapRecord,
} from "./sqlite_event_outbox.js";
import { RunnerParentOutbox } from "./runner_parent_outbox.js";
import {
  readRunnerHostAcknowledgedThrough,
  runnerHostStatePath,
} from "./runner_host_state_store.js";
import type { AuthoritativeRunnerLifecycleOptions } from "./runner_lifecycle_reader.js";
import {
  readRunnerSqliteLifecycle,
  type RunnerLifecycleRecord,
} from "./sqlite_runner_lifecycle.js";
import type { RunnerChildConfig } from "./runner_process_spawn.js";
import type { ProcessIdentity } from "./runner_process_lock.js";
import { isRunnerRegistrationDirectoryName } from "./runner_process_paths.js";
import { readRunnerRegistrationSummary } from "./runner_registration_reader.js";
import type { RunnerRegistrationScanCache } from "./runner_registration_scan_cache.js";
import type { RunnerPhaseObservation } from "./runner_phase_observation.js";

export { readRunnerRegistrationSummary } from "./runner_registration_reader.js";

export interface RunnerRegistration {
  config: RunnerChildConfig;
  pid: number | null;
  pidAlive: boolean;
  registeredAtMs: number;
  bootstrap: RunnerBootstrapRecord | null;
  lifecycle: RunnerLifecycleRecord | null;
  registrationId?: string | null;
  pidStartIdentity?: string | null;
  retiredAt?: string | null;
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
  | "replay_terminal_dead"
  | "retired_terminal"
  | "reap_dead"
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
  cache?: RunnerRegistrationScanCache;
  now?: () => number;
  onScanError?: (failure: RunnerRegistrationScan["errors"][number]) => void;
  logger?: Pick<Logger, "info">;
  phaseObservation?: RunnerPhaseObservation;
}

export async function scanRunnerRegistrations(
  stateDirectory: string,
  options: {
    cache?: RunnerRegistrationScanCache;
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
      options.cache?.prune(new Set());
      return { registrations, errors };
    }
    throw error;
  }
  options.cache?.prune(new Set(entries
    .filter((entry) => entry.isDirectory() && isRunnerRegistrationDirectoryName(entry.name))
    .map((entry) => resolve(stateDirectory, entry.name))));
  for (const entry of entries) {
    if (!entry.isDirectory() || !isRunnerRegistrationDirectoryName(entry.name)) continue;
    const directory = resolve(stateDirectory, entry.name);
    try {
      const readFresh = async () => await readRunnerRegistrationSummary(directory, {
          ...options,
          verifyProcessIdentity: options.verifyProcessIdentity ?? true,
        });
      registrations.push(options.cache
        ? await options.cache.read(directory, readFresh)
        : await readFresh());
    } catch (error) {
      const normalized = asError(error);
      const stage = (normalized as Error & { runnerRegistrationStage?: string })
        .runnerRegistrationStage;
      const causeCode = (normalized as Error & { cause?: NodeJS.ErrnoException })
        .cause?.code;
      if (
        stage === "config"
        && ((normalized as NodeJS.ErrnoException).code === "ENOENT" || causeCode === "ENOENT")
      ) continue;
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
  if (registration.retiredAt) return "retired_terminal";
  const lifecycle = registration.lifecycle;
  if (lifecycle?.execution_state === "reaped") return "already_reaped";
  if (lifecycle?.execution_state === "closed") return "closed";
  if (!lifecycle) {
    if (registration.pidAlive) return "adopt_prebootstrap";
    return nowMs - registration.registeredAtMs < leaseTimeoutMs
      ? "wait_for_bootstrap"
      : "reap_dead";
  }
  if (isTerminalRunnerExecutionState(lifecycle.execution_state)) {
    // A terminal lifecycle says the runner finished, not that its process is
    // still there. Classifying both cases as `replay_terminal` attached an
    // in-memory runner handle to a process that had already exited, which
    // `startExecution` then refused to displace (260820 incident).
    if (registration.pidAlive) return "replay_terminal";
    return "replay_terminal_dead";
  }
  if (!registration.pidAlive) return "reap_dead";
  const progressedAt = Date.parse(lifecycle.progress_at);
  if (!Number.isFinite(progressedAt)) {
    throw new Error(`runner lifecycle progress timestamp invalid: ${lifecycle.progress_at}`);
  }
  // progress_at remains durable observation data. Elapsed wall-clock time is
  // not process-death evidence; adopt() verifies the full runner identity.
  return "adopt_running";
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
  const result = await (options.scan ?? scanRunnerRegistrations)(options.stateDirectory, {
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.phaseObservation ? { phaseObservation: options.phaseObservation } : {}),
  });
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

export async function readRunnerRegistrationForDeletion(
  directory: string,
  phaseObservation?: RunnerPhaseObservation,
): Promise<RunnerRegistration> {
  return await readRunnerRegistrationSummary(directory, {
    verifyProcessIdentity: true,
    ...(phaseObservation ? { phaseObservation } : {}),
  });
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
  phaseObservation?: RunnerPhaseObservation,
): Promise<RunnerRegistration> {
  const outbox = await RunnerParentOutbox.open(
    registration.config.paths.databasePath,
    registration.config.sessionId,
    phaseObservation ? { phaseObservation } : {},
  );
  let bootstrap: RunnerBootstrapRecord | null;
  try {
    bootstrap = await outbox.readBootstrap();
  } finally {
    outbox.close();
  }
  const lifecycle = readRunnerSqliteLifecycle(
    registration.config.paths.databasePath,
    phaseObservation
      ? {
        phaseObservation,
        sessionId: registration.config.sessionId,
        label: "hydrated runner lifecycle",
      }
      : undefined,
  );
  return { ...registration, bootstrap, lifecycle };
}

export async function inspectRunnerDurableState(
  registration: RunnerRegistration,
  phaseObservation?: RunnerPhaseObservation,
): Promise<RunnerDurableInspection> {
  const outbox = await RunnerSqliteEventOutbox.openReadOnly(
    registration.config.paths.databasePath,
    {
      sessionId: registration.config.sessionId,
      ...(phaseObservation ? { phaseObservation } : {}),
    },
  );
  const lifecycle = readRunnerSqliteLifecycle(
    registration.config.paths.databasePath,
    phaseObservation
      ? {
        phaseObservation,
        sessionId: registration.config.sessionId,
        label: "inspected runner lifecycle",
      }
      : undefined,
  );
  let bootstrap: RunnerBootstrapRecord | null;
  let acknowledgedThrough: number | null = null;
  let latestDurableSourceSeq: number | null = null;
  let incompleteDurableWork: boolean;
  let evidence!: ReturnType<RunnerSqliteEventOutbox["inspectPendingDurableEvidence"]>;
  try {
    evidence = phaseObservation
      ? phaseObservation.runSync("dbRead", {
        sessionId: registration.config.sessionId,
        databasePath: registration.config.paths.databasePath,
        label: "runner durable evidence",
      }, () => outbox.inspectPendingDurableEvidence())
      : outbox.inspectPendingDurableEvidence();
    bootstrap = await outbox.readBootstrap();
    if (!bootstrap) {
      incompleteDurableWork = true;
    } else {
      latestDurableSourceSeq = outbox.latestDurableSourceSeq();
      acknowledgedThrough = readRunnerHostAcknowledgedThrough(
        runnerHostStatePath(registration.config.paths.databasePath),
        bootstrap.stream_id,
        bootstrap.session_id,
        phaseObservation
          ? {
            phaseObservation,
            sessionId: registration.config.sessionId,
            label: "runner host ACK",
          }
          : undefined,
      );
      incompleteDurableWork = acknowledgedThrough === null
        || acknowledgedThrough !== latestDurableSourceSeq
        || await (phaseObservation
          ? phaseObservation.runAsync("dbRead", {
            sessionId: registration.config.sessionId,
            databasePath: registration.config.paths.databasePath,
            label: "runner pending durable work",
          }, () => outbox.hasPendingDurableWork(acknowledgedThrough!))
          : outbox.hasPendingDurableWork(acknowledgedThrough));
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
