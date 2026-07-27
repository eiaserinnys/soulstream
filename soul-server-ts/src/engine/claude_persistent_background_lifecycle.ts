import type { Logger } from "pino";

import {
  attachClaudeBackgroundProvenance,
  readClaudeBackgroundProvenance,
} from "./claude_background_provenance.js";
import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import type { ClaudeRuntimeCloseReason } from "./claude_session_runtime.js";

interface PersistentBackgroundRuntime {
  snapshot(): { backgroundTaskIds: string[] };
  observeBackgroundTask(taskId: string, terminal: boolean): void;
}

export function observePersistentBackgroundEvent(
  runtime: PersistentBackgroundRuntime,
  event: ClaudeClientEvent,
): void {
  if (!hasExplicitBackgroundProvenance(event)) return;
  switch (event.type) {
    case "claude_runtime_task_started":
    case "claude_runtime_task_created":
    case "claude_runtime_task_progress":
      runtime.observeBackgroundTask(event.taskId, false);
      return;
    case "claude_runtime_task_completed":
    case "claude_runtime_task_notification":
      runtime.observeBackgroundTask(event.taskId, true);
      return;
    case "claude_runtime_task_updated": {
      const status = event.patch.status;
      const terminal =
        status === "completed" ||
        status === "failed" ||
        status === "stopped" ||
        status === "killed";
      runtime.observeBackgroundTask(event.taskId, terminal);
      return;
    }
    default:
      return;
  }
}

export function isTerminalPersistentBackgroundEvent(
  event: ClaudeClientEvent,
): boolean {
  if (!hasExplicitBackgroundProvenance(event)) return false;
  if (
    event.type === "claude_runtime_task_completed" ||
    event.type === "claude_runtime_task_notification"
  ) {
    return true;
  }
  if (event.type !== "claude_runtime_task_updated") return false;
  return (
    event.patch.status === "completed" ||
    event.patch.status === "failed" ||
    event.patch.status === "stopped" ||
    event.patch.status === "killed"
  );
}

export async function terminalizePersistentBackgroundTasks(params: {
  runtime: PersistentBackgroundRuntime;
  reason: ClaudeRuntimeCloseReason;
  routeEvent(event: ClaudeClientEvent): Promise<void>;
  logger: Pick<Logger, "warn">;
}): Promise<void> {
  const status =
    params.reason === "explicit_cancel"
      ? "stopped"
      : params.reason === "fatal"
        ? "failed"
        : "killed";
  for (const taskId of params.runtime.snapshot().backgroundTaskIds) {
    try {
      const event: ClaudeClientEvent = {
        type: "claude_runtime_task_updated",
        taskId,
        patch: {
          status,
          is_backgrounded: true,
          close_reason: params.reason,
        },
      };
      attachClaudeBackgroundProvenance(event, "runtime_close");
      await params.routeEvent(event);
    } catch (err) {
      // The active journal row is deliberately left recoverable. Query
      // shutdown must not hang because terminal persistence is temporarily
      // unavailable; startup recovery will finish the same semantic task.
      params.logger.warn(
        { err, taskId, reason: params.reason },
        "Claude background terminal persistence deferred to restart recovery",
      );
    }
  }
}

function hasExplicitBackgroundProvenance(event: ClaudeClientEvent): boolean {
  return Boolean(readClaudeBackgroundProvenance(event)) ||
    (
      event.type === "claude_runtime_task_updated" &&
      event.patch.is_backgrounded === true
    );
}
