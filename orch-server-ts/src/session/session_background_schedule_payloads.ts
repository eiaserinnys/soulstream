import type { RequestResponseNodeCommandPayload } from "../node/pending_commands.js";

export type JsonObject = Record<string, unknown>;

export type SessionParams = {
  session_id: string;
};

export type TaskParams = SessionParams & {
  task_id: string;
};

export type ScheduleParams = SessionParams & {
  schedule_id: string;
};

export type ExistingSessionRuntimePayload<TType extends string> =
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

export type ParseResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; message: string };

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
  const parsed = parseOptionalObjectBody(body);
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

function parseOptionalObjectBody(body: unknown): ParseResult<JsonObject> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  return isJsonObject(body)
    ? { ok: true, value: body }
    : { ok: false, message: "Request body must be a JSON object" };
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function firstAliasValue(
  body: JsonObject,
  aliases: readonly string[],
): [string, unknown] {
  for (const alias of aliases) {
    if (alias in body) return [alias, body[alias]];
  }
  return [aliases[0] ?? "field", undefined];
}
