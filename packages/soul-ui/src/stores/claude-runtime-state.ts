import type { SoulSSEEvent } from "@shared/types";

export type ClaudeRuntimeTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "killed";

export interface ClaudeRuntimeTaskView {
  taskId: string;
  status: ClaudeRuntimeTaskStatus;
  updatedAt: number;
  sessionId?: string;
  toolUseId?: string;
  description?: string;
  taskType?: string;
  workflowName?: string;
  prompt?: string;
  skipTranscript?: boolean;
  outputFile?: string;
  summary?: string;
  usage?: Record<string, unknown>;
  lastToolName?: string;
  error?: string;
  isBackgrounded?: boolean;
  endTime?: number;
  totalPausedMs?: number;
}

export interface ClaudeRuntimeView {
  sessionState?: "idle" | "running" | "requires_action";
  runtimeSessionId?: string;
  updatedAt: number;
  tasks: Record<string, ClaudeRuntimeTaskView>;
}

export function applyClaudeRuntimeStoreEvent(
  current: ClaudeRuntimeView | null,
  event: SoulSSEEvent,
): ClaudeRuntimeView | null {
  if (!event.type.startsWith("claude_runtime_")) return current;

  const updatedAt = timestampToMs((event as { timestamp?: number }).timestamp);
  const next: ClaudeRuntimeView = {
    ...(current ?? { tasks: {}, updatedAt }),
    tasks: { ...(current?.tasks ?? {}) },
    updatedAt,
  };

  if (event.type === "claude_runtime_session_state") {
    next.sessionState = event.state;
    if (event.session_id) next.runtimeSessionId = event.session_id;
    return next;
  }

  const taskId = (event as { task_id?: string }).task_id;
  if (!taskId) return next;
  const existing = next.tasks[taskId];
  const runtimeTask: ClaudeRuntimeTaskView = {
    ...(existing ?? { taskId, status: "pending" as const, updatedAt }),
    taskId,
    updatedAt,
  };

  if ("session_id" in event && event.session_id) {
    next.runtimeSessionId = event.session_id;
    runtimeTask.sessionId = event.session_id;
  }
  if ("tool_use_id" in event && event.tool_use_id) runtimeTask.toolUseId = event.tool_use_id;

  switch (event.type) {
    case "claude_runtime_task_started":
      runtimeTask.status = "running";
      copyString(event, "description", runtimeTask);
      copyString(event, "task_type", runtimeTask, "taskType");
      copyString(event, "workflow_name", runtimeTask, "workflowName");
      copyString(event, "prompt", runtimeTask);
      if (typeof event.skip_transcript === "boolean") {
        runtimeTask.skipTranscript = event.skip_transcript;
      }
      break;
    case "claude_runtime_task_updated": {
      const patch = event.patch ?? {};
      if (isTaskStatus(patch.status)) runtimeTask.status = patch.status;
      copyString(patch, "tool_use_id", runtimeTask, "toolUseId");
      copyString(patch, "description", runtimeTask);
      copyString(patch, "task_type", runtimeTask, "taskType");
      copyString(patch, "output_file", runtimeTask, "outputFile");
      copyString(patch, "summary", runtimeTask);
      copyString(patch, "error", runtimeTask);
      if (typeof patch.is_backgrounded === "boolean") {
        runtimeTask.isBackgrounded = patch.is_backgrounded;
      }
      if (typeof patch.end_time === "number") runtimeTask.endTime = patch.end_time;
      if (typeof patch.total_paused_ms === "number") {
        runtimeTask.totalPausedMs = patch.total_paused_ms;
      }
      break;
    }
    case "claude_runtime_task_progress":
      runtimeTask.status = "running";
      copyString(event, "description", runtimeTask);
      copyString(event, "last_tool_name", runtimeTask, "lastToolName");
      copyString(event, "summary", runtimeTask);
      if (event.usage && typeof event.usage === "object") {
        runtimeTask.usage = event.usage;
      }
      break;
    case "claude_runtime_task_notification":
      runtimeTask.status = event.status;
      copyString(event, "output_file", runtimeTask, "outputFile");
      copyString(event, "summary", runtimeTask);
      if (typeof event.skip_transcript === "boolean") {
        runtimeTask.skipTranscript = event.skip_transcript;
      }
      if (event.usage && typeof event.usage === "object") {
        runtimeTask.usage = event.usage;
      }
      break;
  }

  next.tasks[taskId] = runtimeTask;
  return next;
}

function timestampToMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Date.now();
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function isTaskStatus(value: unknown): value is ClaudeRuntimeTaskStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped" ||
    value === "killed"
  );
}

function copyString<T extends object>(
  source: object,
  from: string,
  target: T,
  to: string = from,
): void {
  const value = (source as Record<string, unknown>)[from];
  if (typeof value === "string") {
    (target as Record<string, unknown>)[to] = value;
  }
}
