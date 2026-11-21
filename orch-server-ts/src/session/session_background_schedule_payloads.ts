import type { RequestResponseNodeCommandPayload } from "../node/pending_commands.js";
import type { ControlCommandType } from "@soulstream/wire-schema";
import { parseObjectBody } from "../http/route_validation.js";
import {
  firstAliasValue,
  type ParseResult,
  type SessionParams,
} from "./session_action_command_payloads.js";

export type TaskParams = SessionParams & {
  task_id: string;
};

export type ScheduleParams = SessionParams & {
  schedule_id: string;
};

export type ExistingSessionRuntimePayload<TType extends ControlCommandType> =
  RequestResponseNodeCommandPayload<TType> & {
    agentSessionId: string;
  };

export type ClaudeRuntimeListTasksPayload =
  ExistingSessionRuntimePayload<"claude_runtime_list_tasks">;

export type ClaudeRuntimeTaskOutputPayload =
  ExistingSessionRuntimePayload<"claude_runtime_task_output"> & {
    taskId: string;
  };

export type ClaudeRuntimeStopTaskPayload =
  ExistingSessionRuntimePayload<"claude_runtime_stop_task"> & {
    taskId: string;
  };

export type ClaudeRuntimeBackgroundTasksPayload =
  ExistingSessionRuntimePayload<"claude_runtime_background_tasks"> & {
    toolUseId?: string;
  };

export type ClaudeRuntimeListSchedulesPayload =
  ExistingSessionRuntimePayload<"claude_runtime_list_schedules">;

export type ClaudeRuntimeDeleteSchedulePayload =
  ExistingSessionRuntimePayload<"claude_runtime_delete_schedule"> & {
    scheduleId: string;
  };

export type SessionBackgroundSchedulePayload =
  | ClaudeRuntimeListTasksPayload
  | ClaudeRuntimeTaskOutputPayload
  | ClaudeRuntimeStopTaskPayload
  | ClaudeRuntimeBackgroundTasksPayload
  | ClaudeRuntimeListSchedulesPayload
  | ClaudeRuntimeDeleteSchedulePayload;

export function listTasksPayload(
  agentSessionId: string,
): ClaudeRuntimeListTasksPayload {
  return {
    type: "claude_runtime_list_tasks",
    agentSessionId,
  };
}

export function taskOutputPayload(params: TaskParams): ClaudeRuntimeTaskOutputPayload {
  return {
    type: "claude_runtime_task_output",
    agentSessionId: params.session_id,
    taskId: params.task_id,
  };
}

export function stopTaskPayload(params: TaskParams): ClaudeRuntimeStopTaskPayload {
  return {
    type: "claude_runtime_stop_task",
    agentSessionId: params.session_id,
    taskId: params.task_id,
  };
}

export function backgroundTasksPayload(
  agentSessionId: string,
  body: unknown,
): ParseResult<ClaudeRuntimeBackgroundTasksPayload> {
  const parsed = parseObjectBody(body, { allowEmpty: true });
  if (!parsed.ok) return parsed;

  const [field, toolUseId] = firstAliasValue(parsed.value, [
    "toolUseId",
    "tool_use_id",
  ]);
  if (toolUseId !== undefined && typeof toolUseId !== "string") {
    return { ok: false, message: `${field} must be a string` };
  }

  const payload: ClaudeRuntimeBackgroundTasksPayload = {
    type: "claude_runtime_background_tasks",
    agentSessionId,
  };
  if (toolUseId !== undefined) payload.toolUseId = toolUseId;
  return { ok: true, value: payload };
}

export function listSchedulesPayload(
  agentSessionId: string,
): ClaudeRuntimeListSchedulesPayload {
  return {
    type: "claude_runtime_list_schedules",
    agentSessionId,
  };
}

export function deleteSchedulePayload(
  params: ScheduleParams,
): ClaudeRuntimeDeleteSchedulePayload {
  return {
    type: "claude_runtime_delete_schedule",
    agentSessionId: params.session_id,
    scheduleId: params.schedule_id,
  };
}
