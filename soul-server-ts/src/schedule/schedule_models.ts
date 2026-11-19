import type { SSEEventPayload } from "../engine/protocol.js";

import type { SoulstreamSchedule, SoulstreamScheduleStatus } from "@soulstream/wire-schema/schedule";

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
