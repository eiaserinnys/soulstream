import type { ClaudeClientEvent } from "./claude_event_mapper.js";

export type ClaudeRuntimeSessionState = "idle" | "running" | "requires_action";
export type ClaudeRuntimeTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "killed";

type ClaudeRuntimeTaskSnapshot = {
  status: ClaudeRuntimeTaskStatus;
};

const TERMINAL_CLAUDE_RUNTIME_TASK_STATUSES = new Set<ClaudeRuntimeTaskStatus>([
  "completed",
  "failed",
  "stopped",
  "killed",
]);

export class ClaudeRuntimeState {
  private readonly runtimeTasksById = new Map<string, ClaudeRuntimeTaskSnapshot>();
  private runtimeSessionState: ClaudeRuntimeSessionState | undefined;

  setSessionState(state: ClaudeRuntimeSessionState): void {
    this.runtimeSessionState = state;
  }

  setTaskStatus(taskId: string, status: ClaudeRuntimeTaskStatus): void {
    this.runtimeTasksById.set(taskId, { status });
  }

  getTaskStatus(taskId: string): ClaudeRuntimeTaskStatus | undefined {
    return this.runtimeTasksById.get(taskId)?.status;
  }

  hasPendingWork(): boolean {
    if (this.runtimeSessionState && this.runtimeSessionState !== "idle") return true;
    for (const runtimeTask of this.runtimeTasksById.values()) {
      if (!TERMINAL_CLAUDE_RUNTIME_TASK_STATUSES.has(runtimeTask.status)) return true;
    }
    return false;
  }

  makeTimeoutEvents(runtimeDrainMaxMs: number): ClaudeClientEvent[] {
    const message = `Claude runtime drain timed out after ${runtimeDrainMaxMs}ms; closing query.`;
    const events: ClaudeClientEvent[] = [
      {
        type: "debug",
        message,
      },
    ];

    for (const [taskId, runtimeTask] of this.runtimeTasksById.entries()) {
      if (TERMINAL_CLAUDE_RUNTIME_TASK_STATUSES.has(runtimeTask.status)) continue;
      this.runtimeTasksById.set(taskId, { status: "failed" });
      events.push({
        type: "claude_runtime_task_notification",
        taskId,
        status: "failed",
        summary: message,
      });
    }

    if (this.runtimeSessionState && this.runtimeSessionState !== "idle") {
      this.runtimeSessionState = "idle";
      events.push({
        type: "claude_runtime_session_state",
        state: "idle",
      });
    }

    events.push({
      type: "error",
      fatal: true,
      errorCode: "claude_runtime_timeout",
      message,
    });
    return events;
  }

  clear(): void {
    this.runtimeTasksById.clear();
    this.runtimeSessionState = undefined;
  }
}

export function isRuntimeSystemMessage(message: Record<string, unknown> | undefined): boolean {
  if (message?.type !== "system") return false;
  return (
    message.subtype === "session_state_changed" ||
    message.subtype === "task_started" ||
    message.subtype === "task_updated" ||
    message.subtype === "task_progress" ||
    message.subtype === "task_notification" ||
    message.subtype === "notification" ||
    message.subtype === "mirror_error"
  );
}

export function isRuntimeClientEvent(event: ClaudeClientEvent): boolean {
  return event.type.startsWith("claude_runtime_");
}

export function isFatalClientError(event: ClaudeClientEvent): boolean {
  return event.type === "error" && event.fatal !== false;
}

export function parseRuntimeSessionState(value: unknown): ClaudeRuntimeSessionState | undefined {
  return value === "idle" || value === "running" || value === "requires_action"
    ? value
    : undefined;
}

export function parseRuntimeTaskStatus(value: unknown): ClaudeRuntimeTaskStatus | undefined {
  return value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped" ||
    value === "killed"
    ? value
    : undefined;
}

export function parseRuntimeNotificationStatus(
  value: unknown,
): "completed" | "failed" | "stopped" | undefined {
  return value === "completed" || value === "failed" || value === "stopped"
    ? value
    : undefined;
}
