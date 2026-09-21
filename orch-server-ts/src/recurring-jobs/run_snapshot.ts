import type { RecurringJob, RecurringJobRun } from "./types.js";

/**
 * Runs are immutable execution intents. In particular, a later job edit must
 * not replace a queued run's prompt, caller, target, or late eligibility.
 */
export function jobForRun(job: RecurringJob, run: RecurringJobRun): RecurringJob {
  const snapshot = run.jobSnapshot;
  return {
    ...job,
    name: snapshotText(snapshot, "name"),
    prompt: snapshotText(snapshot, "prompt"),
    timezone: snapshotText(snapshot, "timezone"),
    scheduleExpressions: snapshotStrings(snapshot, "scheduleExpressions"),
    nodeId: snapshotText(snapshot, "nodeId"),
    agentId: snapshotText(snapshot, "agentId"),
    modelPreset: snapshotNullableText(snapshot, "modelPreset"),
    container: snapshotContainer(snapshot.container),
    folderId: snapshotText(snapshot, "folderId"),
    executionCaller: snapshotRecord(snapshot.executionCaller, "executionCaller"),
    lateRunWindowSeconds: snapshotPositiveInteger(snapshot.lateRunWindowSeconds, "lateRunWindowSeconds"),
  };
}

function snapshotText(snapshot: Readonly<Record<string, unknown>>, key: string): string {
  const value = snapshot[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Recurring run snapshot is missing ${key}.`);
  }
  return value;
}

function snapshotNullableText(
  snapshot: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = snapshot[key];
  if (value === null) return null;
  return snapshotText(snapshot, key);
}

function snapshotStrings(snapshot: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = snapshot[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Recurring run snapshot is missing ${key}.`);
  }
  return [...value] as string[];
}

function snapshotContainer(value: unknown): RecurringJob["container"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recurring run snapshot is missing container.");
  }
  const candidate = value as Record<string, unknown>;
  if ((candidate.kind !== "folder" && candidate.kind !== "task") || typeof candidate.id !== "string" || !candidate.id.trim()) {
    throw new Error("Recurring run snapshot has an invalid container.");
  }
  return { kind: candidate.kind, id: candidate.id };
}

function snapshotRecord(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Recurring run snapshot is missing ${key}.`);
  }
  return { ...(value as Record<string, unknown>) };
}

function snapshotPositiveInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Recurring run snapshot has an invalid ${key}.`);
  }
  return value;
}
