import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { RunnerBootstrapRecord } from "./sqlite_event_outbox.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import type { RunnerLifecycleRecord } from "./sqlite_runner_lifecycle.js";
import {
  readRunnerLifecycleSummary,
  RunnerSqliteLifecycle,
} from "./sqlite_runner_lifecycle.js";
import {
  readRunnerChildConfig,
  readRunnerPid,
  type RunnerChildConfig,
} from "./runner_process_spawn.js";

export interface RunnerRegistration {
  config: RunnerChildConfig;
  pid: number | null;
  pidAlive: boolean;
  registeredAtMs: number;
  bootstrap: RunnerBootstrapRecord | null;
  lifecycle: RunnerLifecycleRecord | null;
}

export interface RunnerRegistrationScan {
  registrations: RunnerRegistration[];
  errors: Array<{ directory: string; error: Error; sessionId?: string; codeSha?: string }>;
}

export interface RunnerDurableInspection {
  registration: RunnerRegistration;
  incompleteDurableWork: boolean;
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

export interface LiveRunnerSessionIdsOptions {
  stateDirectory: string;
  leaseTimeoutMs: number;
  scan?: typeof scanRunnerRegistrations;
  now?: () => number;
  onScanError?: (failure: RunnerRegistrationScan["errors"][number]) => void;
}

export async function scanRunnerRegistrations(
  stateDirectory: string,
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
      registrations.push(await readRunnerRegistrationSummary(directory));
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
  if (!Number.isFinite(nowMs) || leaseTimeoutMs <= 0) {
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
  if (lifecycle.execution_state !== "running") return "replay_terminal";
  if (!registration.pidAlive) return "reap_dead";
  const progressedAt = Date.parse(lifecycle.progress_at);
  if (!Number.isFinite(progressedAt)) {
    throw new Error(`runner lifecycle progress timestamp invalid: ${lifecycle.progress_at}`);
  }
  return nowMs - progressedAt >= leaseTimeoutMs
    ? "reap_stalled"
    : "adopt_running";
}

/**
 * Returns the durable runner inventory that is safe to advertise as running.
 * Unreadable registrations are isolated. A parsed session identity is retained
 * conservatively in the positive inventory; healthy registrations are still
 * reported so one damaged directory cannot erase the entire node inventory.
 */
export async function listLiveRunnerSessionIds(
  options: LiveRunnerSessionIdsOptions,
): Promise<string[]> {
  const result = await (options.scan ?? scanRunnerRegistrations)(options.stateDirectory);
  for (const failure of result.errors) options.onScanError?.(failure);
  const nowMs = (options.now ?? Date.now)();
  const sessionIds = new Set<string>();
  for (const failure of result.errors) {
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
): Promise<RunnerRegistration> {
  const configPath = resolve(directory, "runner-config.json");
  const config = await readRunnerChildConfig(configPath);
  try {
    if (resolve(config.paths.sessionDirectory) !== directory) {
      throw new Error(`runner config directory mismatch: ${directory}`);
    }
    const configStat = await stat(configPath);
    await stat(config.paths.databasePath);
    const pid = await readRunnerPid(config.paths.pidPath);
    const lifecycle = await readRunnerLifecycleSummary(config.paths.databasePath);
    if (lifecycle && lifecycle.session_id !== config.sessionId) {
      throw new Error(`runner lifecycle summary session mismatch: ${directory}`);
    }
    return {
      config,
      pid,
      pidAlive: pid !== null && isPidAlive(pid),
      registeredAtMs: configStat.mtimeMs,
      bootstrap: null,
      lifecycle,
    };
  } catch (error) {
    const normalized = asError(error) as Error & {
      runnerSessionId?: string;
      runnerCodeSha?: string;
    };
    normalized.runnerSessionId = config.sessionId;
    normalized.runnerCodeSha = config.codeSha;
    throw normalized;
  }
}

export async function hydrateRunnerRegistration(
  registration: RunnerRegistration,
): Promise<RunnerRegistration> {
  const outbox = await RunnerSqliteEventOutbox.open(registration.config.paths.databasePath);
  let bootstrap: RunnerBootstrapRecord | null;
  try {
    bootstrap = await outbox.readBootstrap();
  } finally {
    outbox.close();
  }
  const lifecycleStore = RunnerSqliteLifecycle.open(registration.config.paths.databasePath);
  let lifecycle: RunnerLifecycleRecord | null;
  try {
    lifecycle = lifecycleStore.read();
  } finally {
    lifecycleStore.close();
  }
  return { ...registration, bootstrap, lifecycle };
}

export async function inspectRunnerDurableState(
  registration: RunnerRegistration,
): Promise<RunnerDurableInspection> {
  const outbox = await RunnerSqliteEventOutbox.open(registration.config.paths.databasePath);
  let bootstrap: RunnerBootstrapRecord | null;
  let incompleteDurableWork: boolean;
  try {
    bootstrap = await outbox.readBootstrap();
    incompleteDurableWork = await outbox.hasPendingDurableWork();
  } finally {
    outbox.close();
  }
  const lifecycleStore = RunnerSqliteLifecycle.open(registration.config.paths.databasePath);
  let lifecycle: RunnerLifecycleRecord | null;
  try {
    lifecycle = lifecycleStore.read();
  } finally {
    lifecycleStore.close();
  }
  return {
    registration: { ...registration, bootstrap, lifecycle },
    incompleteDurableWork,
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
