import type { DatabaseSync } from "node:sqlite";

import type { RunnerExecutionState } from "./sqlite_event_outbox_schema.js";

export interface RunnerLifecycleRecord {
  session_id: string;
  runner_pid: number;
  execution_command_id: string;
  execution_state: RunnerExecutionState;
  progress_seq: number;
  progress_at: string;
  liveness_at: string;
  in_flight_tools: RunnerInFlightTool[];
  terminal_error: { code: string; message: string } | null;
}

export interface RunnerInFlightTool {
  tool_use_id: string;
  started_at: string;
}

export function readRunnerLifecycleRecord(
  database: DatabaseSync,
): RunnerLifecycleRecord | null {
  const row = database.prepare(`
    SELECT session_id, runner_pid, execution_command_id, execution_state,
           progress_seq, progress_at, liveness_at, in_flight_tools_json,
           terminal_error_json
    FROM runner_event_outbox WHERE record_kind = 'bootstrap'
  `).get() as LifecycleRow | undefined;
  if (row && row.runner_pid !== null && row.execution_command_id !== null
    && row.execution_state !== null && row.progress_at !== null) {
    return lifecycleRecord(row);
  }
  const prebootstrap = database.prepare(`
    SELECT session_id, runner_pid, execution_command_id, execution_state,
           progress_seq, progress_at, liveness_at, in_flight_tools_json,
           terminal_error_json
    FROM runner_prebootstrap_lifecycle WHERE singleton = 1
  `).get() as LifecycleRow | undefined;
  return prebootstrap ? lifecycleRecord(prebootstrap) : null;
}

export function validateLifecycleSummary(value: unknown): RunnerLifecycleRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("runner lifecycle summary invalid");
  }
  const record = value as Partial<RunnerLifecycleRecord>;
  const livenessAt = record.liveness_at ?? record.progress_at;
  const legacyRecord = record as Partial<RunnerLifecycleRecord> & {
    in_flight_tool_ids?: unknown;
  };
  const inFlightTools = record.in_flight_tools ?? legacyToolIds(
    legacyRecord.in_flight_tool_ids,
    record.progress_at,
  );
  if (
    typeof record.session_id !== "string"
    || !record.session_id
    || !Number.isSafeInteger(record.runner_pid)
    || (record.runner_pid ?? 0) <= 0
    || typeof record.execution_command_id !== "string"
    || !record.execution_command_id
    || !["running", "completed", "failed", "reaped", "closed"].includes(
      record.execution_state ?? "",
    )
    || !Number.isSafeInteger(record.progress_seq)
    || (record.progress_seq ?? -1) < 0
    || typeof record.progress_at !== "string"
    || !Number.isFinite(Date.parse(record.progress_at))
    || typeof livenessAt !== "string"
    || !Number.isFinite(Date.parse(livenessAt))
    || !isInFlightToolArray(inFlightTools)
    || !(record.terminal_error === null
      || (typeof record.terminal_error === "object"
        && typeof record.terminal_error?.code === "string"
        && typeof record.terminal_error?.message === "string"))
  ) throw new Error("runner lifecycle summary invalid");
  const normalizedRecord = { ...legacyRecord };
  delete normalizedRecord.in_flight_tool_ids;
  return {
    ...normalizedRecord,
    liveness_at: livenessAt,
    in_flight_tools: inFlightTools.map((tool) => ({ ...tool })),
  } as RunnerLifecycleRecord;
}

function lifecycleRecord(row: LifecycleRow): RunnerLifecycleRecord {
  if (row.runner_pid === null || row.execution_command_id === null
    || row.execution_state === null || row.progress_at === null) {
    throw new Error("runner lifecycle row incomplete");
  }
  return {
    session_id: row.session_id,
    runner_pid: row.runner_pid,
    execution_command_id: row.execution_command_id,
    execution_state: row.execution_state,
    progress_seq: row.progress_seq,
    progress_at: row.progress_at,
    liveness_at: row.liveness_at ?? row.progress_at,
    in_flight_tools: parseInFlightTools(row.in_flight_tools_json),
    terminal_error: row.terminal_error_json === null
      ? null
      : JSON.parse(row.terminal_error_json) as { code: string; message: string },
  };
}

function parseInFlightTools(value: string | null): RunnerInFlightTool[] {
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  if (!isInFlightToolArray(parsed)) throw new Error("runner in-flight tools invalid");
  return parsed.map((tool) => ({ ...tool }));
}

function isToolIdArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((toolUseId) => typeof toolUseId === "string" && toolUseId.length > 0)
    && new Set(value).size === value.length;
}

function isInFlightToolArray(value: unknown): value is RunnerInFlightTool[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) return false;
    const tool = candidate as Partial<RunnerInFlightTool>;
    if (typeof tool.tool_use_id !== "string" || tool.tool_use_id.length === 0
      || typeof tool.started_at !== "string"
      || !Number.isFinite(Date.parse(tool.started_at))
      || ids.has(tool.tool_use_id)) return false;
    ids.add(tool.tool_use_id);
  }
  return true;
}

function legacyToolIds(value: unknown, progressedAt: unknown): RunnerInFlightTool[] {
  if (value === undefined) return [];
  if (!isToolIdArray(value) || typeof progressedAt !== "string") {
    throw new Error("runner lifecycle summary invalid");
  }
  return value.map((toolUseId) => ({
    tool_use_id: toolUseId,
    started_at: progressedAt,
  }));
}

type LifecycleRow = {
  session_id: string;
  runner_pid: number | null;
  execution_command_id: string | null;
  execution_state: RunnerExecutionState | null;
  progress_seq: number;
  progress_at: string | null;
  liveness_at: string | null;
  in_flight_tools_json: string | null;
  terminal_error_json: string | null;
};
