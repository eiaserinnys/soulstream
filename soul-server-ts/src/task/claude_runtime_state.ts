import type { SSEEventPayload } from "../engine/protocol.js";

import type {
  ClaudeRuntimeSessionState,
  ClaudeRuntimeState,
  ClaudeRuntimeTaskState,
  ClaudeRuntimeTaskStatus,
  Task,
} from "./task_models.js";

const TERMINAL_CLAUDE_RUNTIME_TASK_STATUSES = new Set<ClaudeRuntimeTaskStatus>([
  "completed",
  "failed",
  "stopped",
  "killed",
]);

export function applyClaudeRuntimeEvent(task: Task, event: SSEEventPayload): boolean {
  const payload = event as Record<string, unknown>;
  const eventType = asString(payload.type);
  if (!eventType?.startsWith("claude_runtime_")) return false;

  const runtime = ensureClaudeRuntimeState(task);
  const now = timestampToEpochMs(payload.timestamp) ?? Date.now();
  runtime.updatedAt = now;

  if (eventType === "claude_runtime_session_state") {
    const state = parseSessionState(payload.state);
    if (!state) return true;
    runtime.sessionState = state;
    const sessionId = asString(payload.session_id);
    if (sessionId) runtime.sessionId = sessionId;
    return true;
  }

  const taskId = asString(payload.task_id);
  if (!taskId) return true;
  const runtimeTask = ensureRuntimeTask(runtime, taskId, now);
  runtimeTask.updatedAt = now;
  const sessionId = asString(payload.session_id);
  if (sessionId) {
    runtime.sessionId = sessionId;
    runtimeTask.sessionId = sessionId;
  }
  const toolUseId = asString(payload.tool_use_id);
  if (toolUseId) runtimeTask.toolUseId = toolUseId;

  switch (eventType) {
    case "claude_runtime_task_started":
      runtimeTask.status = "running";
      copyString(payload, "description", runtimeTask);
      copyString(payload, "task_type", runtimeTask, "taskType");
      copyString(payload, "workflow_name", runtimeTask, "workflowName");
      copyString(payload, "prompt", runtimeTask);
      copyBoolean(payload, "skip_transcript", runtimeTask, "skipTranscript");
      break;

    case "claude_runtime_task_updated": {
      const patch = asRecord(payload.patch) ?? {};
      const status = parseTaskStatus(patch.status);
      if (status) runtimeTask.status = status;
      const toolUseId = asString(patch.tool_use_id);
      if (toolUseId) runtimeTask.toolUseId = toolUseId;
      copyString(patch, "description", runtimeTask);
      copyString(patch, "task_type", runtimeTask, "taskType");
      copyString(patch, "output_file", runtimeTask, "outputFile");
      copyString(patch, "summary", runtimeTask);
      copyString(patch, "error", runtimeTask);
      copyBoolean(patch, "is_backgrounded", runtimeTask, "isBackgrounded");
      copyNumber(patch, "end_time", runtimeTask, "endTime");
      copyNumber(patch, "total_paused_ms", runtimeTask, "totalPausedMs");
      break;
    }

    case "claude_runtime_task_progress":
      runtimeTask.status = "running";
      copyString(payload, "description", runtimeTask);
      copyString(payload, "summary", runtimeTask);
      copyString(payload, "last_tool_name", runtimeTask, "lastToolName");
      if (asRecord(payload.usage)) runtimeTask.usage = asRecord(payload.usage);
      break;

    case "claude_runtime_task_notification": {
      const status = parseTaskStatus(payload.status);
      if (status) runtimeTask.status = status;
      copyString(payload, "output_file", runtimeTask, "outputFile");
      copyString(payload, "summary", runtimeTask);
      copyBoolean(payload, "skip_transcript", runtimeTask, "skipTranscript");
      if (asRecord(payload.usage)) runtimeTask.usage = asRecord(payload.usage);
      break;
    }
  }

  return true;
}

export function hasPendingClaudeRuntimeWork(task: Task): boolean {
  const runtime = task.claudeRuntime;
  if (!runtime) return false;
  if (runtime.sessionState && runtime.sessionState !== "idle") return true;
  return Object.values(runtime.tasks).some(
    (runtimeTask) => !TERMINAL_CLAUDE_RUNTIME_TASK_STATUSES.has(runtimeTask.status),
  );
}

function ensureClaudeRuntimeState(task: Task): ClaudeRuntimeState {
  if (!task.claudeRuntime) {
    task.claudeRuntime = {
      updatedAt: Date.now(),
      tasks: {},
    };
  }
  return task.claudeRuntime;
}

function ensureRuntimeTask(
  runtime: ClaudeRuntimeState,
  taskId: string,
  now: number,
): ClaudeRuntimeTaskState {
  const existing = runtime.tasks[taskId];
  if (existing) return existing;
  const created: ClaudeRuntimeTaskState = {
    taskId,
    status: "pending",
    updatedAt: now,
  };
  runtime.tasks[taskId] = created;
  return created;
}

function parseSessionState(value: unknown): ClaudeRuntimeSessionState | undefined {
  return value === "idle" || value === "running" || value === "requires_action"
    ? value
    : undefined;
}

function parseTaskStatus(value: unknown): ClaudeRuntimeTaskStatus | undefined {
  return value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped" ||
    value === "killed"
    ? value
    : undefined;
}

function copyString(
  source: Record<string, unknown>,
  sourceKey: string,
  target: object,
  targetKey = sourceKey,
): void {
  const value = asString(source[sourceKey]);
  if (value !== undefined) (target as Record<string, unknown>)[targetKey] = value;
}

function copyBoolean(
  source: Record<string, unknown>,
  sourceKey: string,
  target: object,
  targetKey = sourceKey,
): void {
  const value = source[sourceKey];
  if (typeof value === "boolean") (target as Record<string, unknown>)[targetKey] = value;
}

function copyNumber(
  source: Record<string, unknown>,
  sourceKey: string,
  target: object,
  targetKey = sourceKey,
): void {
  const value = asNumber(source[sourceKey]);
  if (value !== undefined) (target as Record<string, unknown>)[targetKey] = value;
}

function timestampToEpochMs(value: unknown): number | undefined {
  const seconds = asNumber(value);
  return seconds === undefined ? undefined : seconds * 1000;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
