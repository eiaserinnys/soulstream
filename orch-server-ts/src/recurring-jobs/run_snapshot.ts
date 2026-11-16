import type {
  RecurringJob,
  RecurringJobEventTrigger,
  RecurringJobRun,
} from "./types.js";

/**
 * Runs are immutable execution intents. In particular, a later job edit must
 * not replace a queued run's prompt, caller, target, or late eligibility.
 */
export function jobForRun(job: RecurringJob, run: RecurringJobRun): RecurringJob {
  const snapshot = run.jobSnapshot;
  const scheduleKind = snapshot.scheduleKind === undefined ? "recurring" : snapshot.scheduleKind;
  if (scheduleKind !== "recurring" && scheduleKind !== "once" && scheduleKind !== "event") {
    throw new Error("Recurring run snapshot has an invalid scheduleKind.");
  }
  return {
    ...job,
    name: snapshotText(snapshot, "name"),
    prompt: snapshotText(snapshot, "prompt"),
    timezone: snapshotText(snapshot, "timezone"),
    scheduleKind,
    scheduleExpressions: snapshotStrings(
      snapshot,
      "scheduleExpressions",
      scheduleKind !== "recurring",
    ),
    runAt: snapshot.runAt === undefined ? null : snapshotNullableText(snapshot, "runAt"),
    eventTrigger: snapshotEventTrigger(snapshot.eventTrigger, scheduleKind),
    nodeId: snapshotText(snapshot, "nodeId"),
    agentId: snapshotText(snapshot, "agentId"),
    modelPreset: snapshotNullableText(snapshot, "modelPreset"),
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

function snapshotStrings(
  snapshot: Readonly<Record<string, unknown>>,
  key: string,
  allowEmpty = false,
): string[] {
  const value = snapshot[key];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Recurring run snapshot is missing ${key}.`);
  }
  return [...value] as string[];
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

function snapshotEventTrigger(
  value: unknown,
  scheduleKind: RecurringJob["scheduleKind"],
): RecurringJobEventTrigger | null {
  if (scheduleKind !== "event") {
    if (value === undefined || value === null) return null;
    throw new Error("Recurring run snapshot has an eventTrigger on a non-event job.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recurring run snapshot is missing eventTrigger.");
  }
  const trigger = value as Record<string, unknown>;
  if (trigger.type !== "node_connected") {
    throw new Error("Recurring run snapshot has an invalid eventTrigger.type.");
  }
  return {
    type: "node_connected",
    nodeId: snapshotText(trigger, "nodeId"),
    settleSeconds: snapshotNonNegativeInteger(trigger.settleSeconds, "eventTrigger.settleSeconds"),
    cooldownSeconds: snapshotNonNegativeInteger(trigger.cooldownSeconds, "eventTrigger.cooldownSeconds"),
    repeat: snapshotBoolean(trigger.repeat, "eventTrigger.repeat"),
  };
}

function snapshotNonNegativeInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Recurring run snapshot has an invalid ${key}.`);
  }
  return value;
}

function snapshotBoolean(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Recurring run snapshot has an invalid ${key}.`);
  }
  return value;
}
