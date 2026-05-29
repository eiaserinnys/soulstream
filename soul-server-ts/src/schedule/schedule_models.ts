import type { SSEEventPayload } from "../engine/protocol.js";

export type SoulstreamScheduleKind = "wakeup" | "cron";

export type SoulstreamScheduleStatus =
  | "active"
  | "dispatching"
  | "firing"
  | "completed"
  | "cancelled"
  | "failed"
  | "orphaned";

export interface SoulstreamSchedule {
  scheduleId: string;
  sessionId: string;
  kind: SoulstreamScheduleKind;
  status: SoulstreamScheduleStatus;
  prompt: string;
  sourceTool: string;
  toolUseId: string | null;
  cronExpression: string | null;
  runOnceAt: string | null;
  timezone: string;
  recurring: boolean;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  firedCount: number;
  lastError: string | null;
  claimToken: string | null;
  claimedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleCreateInput {
  scheduleId: string;
  sessionId: string;
  kind: SoulstreamScheduleKind;
  prompt: string;
  sourceTool: string;
  toolUseId?: string | null;
  cronExpression?: string | null;
  runOnceAt?: Date | null;
  timezone?: string;
  recurring: boolean;
  nextRunAt: Date;
  createdAt?: Date;
}

export interface ClaimedSchedule {
  schedule: SoulstreamSchedule;
  claimToken: string;
}

export type CancelScheduleOutcome =
  | "cancelled"
  | "already_firing"
  | "not_cancellable"
  | "not_found";

export interface CancelScheduleResult {
  outcome: CancelScheduleOutcome;
  schedule: SoulstreamSchedule | null;
}

export interface ScheduleListResponse {
  sessionId: string;
  nextRunAt: string | null;
  schedules: SoulstreamSchedule[];
}

export interface ScheduleDeleteResponse {
  sessionId: string;
  scheduleId: string;
  status: SoulstreamScheduleStatus | "not_found" | "already_firing";
  deleted: boolean;
  schedule: SoulstreamSchedule | null;
}

export function scheduleToUpdatedEvent(schedule: SoulstreamSchedule): SSEEventPayload {
  return {
    type: "claude_runtime_schedule_updated",
    schedule_id: schedule.scheduleId,
    session_id: schedule.sessionId,
    schedule_kind: schedule.kind,
    status: schedule.status,
    prompt: schedule.prompt,
    source_tool: schedule.sourceTool,
    tool_use_id: schedule.toolUseId,
    cron_expression: schedule.cronExpression,
    run_once_at: schedule.runOnceAt,
    timezone: schedule.timezone,
    recurring: schedule.recurring,
    next_run_at: schedule.nextRunAt,
    last_fired_at: schedule.lastFiredAt,
    fired_count: schedule.firedCount,
    last_error: schedule.lastError,
    created_at: schedule.createdAt,
    updated_at: schedule.updatedAt,
    timestamp: Date.now() / 1000,
  } as SSEEventPayload;
}

export function scheduleToDeletedEvent(schedule: SoulstreamSchedule): SSEEventPayload {
  return {
    type: "claude_runtime_schedule_deleted",
    schedule_id: schedule.scheduleId,
    session_id: schedule.sessionId,
    status: schedule.status,
    updated_at: schedule.updatedAt,
    timestamp: Date.now() / 1000,
  } as SSEEventPayload;
}

export function nextRunAtFromSchedules(
  schedules: SoulstreamSchedule[],
): string | null {
  const candidates = schedules
    .map((schedule) => schedule.nextRunAt)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort();
  return candidates[0] ?? null;
}
