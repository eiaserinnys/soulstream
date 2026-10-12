import { dirname, resolve } from "node:path";

import type {
  RunnerDurableInspection,
  RunnerRegistration,
} from "./runner_process_registry.js";

export function hasCentralDeletionOverride(
  registration: RunnerRegistration,
  policy: { centralSessionExists(sessionId: string): Promise<boolean> } | undefined,
): boolean {
  return Boolean(policy && registration.retiredAt && !registration.pidAlive);
}

export function hasProvenEmptyPrebootstrapEvidence(
  inspection: Pick<
    RunnerDurableInspection,
    "durableRecordCount" | "unacknowledgedIpcFrameCount" | "pendingInterventionCount"
  >,
): boolean {
  return inspection.durableRecordCount === 0
    && inspection.unacknowledgedIpcFrameCount === 0
    && inspection.pendingInterventionCount === 0;
}

export function terminalCandidateReason(
  registration: RunnerRegistration,
  nowMs: number,
  retentionMs: number,
): string | null {
  if (registration.retiredAt) {
    const retiredAt = Date.parse(registration.retiredAt);
    if (!Number.isFinite(retiredAt)) return "retirement_timestamp_invalid";
    if (nowMs - retiredAt < retentionMs) return "retention_window";
    return null;
  }
  if (registration.pid === null) return "pid_evidence_missing";
  if (registration.pidAlive) return "live_runner";
  const lifecycle = registration.lifecycle;
  if (!lifecycle) return "lifecycle_missing";
  if (lifecycle.execution_state === "running") return "running_lifecycle";
  const terminalAt = Date.parse(lifecycle.progress_at);
  if (!Number.isFinite(terminalAt)) return "terminal_timestamp_invalid";
  if (nowMs - terminalAt < retentionMs) return "retention_window";
  return null;
}

export function countRetainedReasons(
  retained: Array<{ reason: string }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of retained) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  return counts;
}

export function assertOwnedSessionDirectory(
  stateDirectory: string,
  sessionDirectory: string,
): void {
  const state = resolve(stateDirectory);
  const session = resolve(sessionDirectory);
  if (session === state || resolve(dirname(session)) !== state) {
    throw new Error(`runner session directory escaped state root: ${sessionDirectory}`);
  }
}

export function sameRegistrationGeneration(
  left: RunnerRegistration,
  right: RunnerRegistration,
): boolean {
  return left.config.sessionId === right.config.sessionId
    && left.config.codeSha === right.config.codeSha
    && left.config.paths.sessionDirectory === right.config.paths.sessionDirectory
    && (left.registrationId ?? null) === (right.registrationId ?? null)
    && left.pid === right.pid
    && (left.pidStartIdentity ?? null) === (right.pidStartIdentity ?? null);
}
