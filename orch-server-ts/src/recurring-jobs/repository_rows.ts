import type {
  RecurringJob,
  RecurringJobEventTrigger,
  RecurringJobRun,
  RecurringNodePresence,
} from "./types.js";

export type Row = Record<string, unknown>;

export function jobFromRow(row: Row): RecurringJob {
  return {
    jobId: stringValue(row.job_id),
    ownerEmail: stringValue(row.owner_email),
    executionCaller: objectValue(row.execution_caller),
    name: stringValue(row.name),
    prompt: stringValue(row.prompt),
    scheduleExpressions: stringArray(row.schedule_expressions),
    scheduleKind: row.schedule_kind === "once"
      ? "once"
      : row.schedule_kind === "event" ? "event" : "recurring",
    runAt: timestampOrNull(row.run_at),
    eventTrigger: eventTriggerFromRow(row.event_trigger),
    eventLastFiredAt: timestampOrNull(row.event_last_fired_at),
    timezone: stringValue(row.timezone),
    nodeId: stringValue(row.node_id),
    agentId: stringValue(row.agent_id),
    modelPreset: nullableString(row.model_preset),
    modelPresetFallbacks: row.model_preset_fallbacks == null ? [] : stringArray(row.model_preset_fallbacks),
    folderId: stringValue(row.folder_id),
    enabled: Boolean(row.enabled),
    archivedAt: timestampOrNull(row.archived_at),
    lateRunWindowSeconds: positiveInteger(row.late_run_window_seconds),
    nextRunAt: timestampOrNull(row.next_run_at),
    version: positiveInteger(row.version),
    createdIdempotencyKey: stringValue(row.created_idempotency_key),
    createdBy: stringValue(row.created_by),
    updatedBy: stringValue(row.updated_by),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

export function runFromRow(row: Row): RecurringJobRun {
  return {
    runId: stringValue(row.run_id), jobId: stringValue(row.job_id),
    trigger: row.trigger === "manual" ? "manual" : row.trigger === "event" ? "event" : "scheduled",
    scheduledFor: timestampOrNull(row.scheduled_for),
    manualIdempotencyKey: nullableString(row.manual_idempotency_key),
    sessionId: stringValue(row.session_id), jobSnapshot: objectValue(row.job_snapshot),
    state: stringValue(row.state) as RecurringJobRun["state"],
    reasonCode: nullableString(row.reason_code), reasonMessage: nullableString(row.reason_message),
    createdAt: timestamp(row.created_at), startedAt: timestampOrNull(row.started_at),
    finishedAt: timestampOrNull(row.finished_at), updatedAt: timestamp(row.updated_at),
  };
}

export function presenceFromRow(row: Row): RecurringNodePresence {
  return {
    nodeId: stringValue(row.node_id),
    episodeStartedAt: timestamp(row.episode_started_at),
    lastSeenAt: timestamp(row.last_seen_at),
  };
}

export function requiredRow(rows: readonly Row[], operation: string): Row {
  if (!rows[0]) throw new Error(`${operation} did not return a row`);
  return rows[0];
}

function eventTriggerFromRow(value: unknown): RecurringJobEventTrigger | null {
  if (value === null || value === undefined) return null;
  const trigger = objectValue(value);
  if (trigger.type !== "node_connected") throw new Error("invalid recurring event trigger");
  return {
    type: "node_connected",
    nodeId: stringValue(trigger.nodeId),
    settleSeconds: nonNegativeInteger(trigger.settleSeconds),
    cooldownSeconds: nonNegativeInteger(trigger.cooldownSeconds),
    repeat: booleanValue(trigger.repeat),
  };
}

function stringValue(value: unknown): string { if (typeof value !== "string") throw new Error("invalid recurring job row"); return value; }
function nullableString(value: unknown): string | null { return value === null || value === undefined ? null : stringValue(value); }
function objectValue(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid recurring job JSON"); return value as Record<string, unknown>; }
function stringArray(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("invalid recurring schedule array"); return [...value] as string[]; }
function positiveInteger(value: unknown): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("invalid recurring integer"); return parsed; }
function nonNegativeInteger(value: unknown): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid recurring event integer"); return parsed; }
function booleanValue(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("invalid recurring event boolean"); return value; }
function timestamp(value: unknown): string { const date = value instanceof Date ? value : new Date(String(value)); if (!Number.isFinite(date.getTime())) throw new Error("invalid recurring timestamp"); return date.toISOString(); }
function timestampOrNull(value: unknown): string | null { return value === null || value === undefined ? null : timestamp(value); }
