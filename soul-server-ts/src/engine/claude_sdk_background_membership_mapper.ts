import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import { attachClaudeBackgroundProvenance } from
  "./claude_background_provenance.js";
import {
  asArray,
  asRecord,
  asString,
} from "./claude_sdk_helpers.js";
import type { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";

/**
 * Maps the SDK's authoritative background membership snapshot into runtime
 * events. Keeping this boundary separate prevents ordinary synchronous task
 * notifications from being inferred as background work downstream.
 */
export function mapClaudeBackgroundTaskMembership(
  message: Record<string, unknown>,
  runtimeState: ClaudeRuntimeState,
): ClaudeClientEvent[] {
  const tasks = (asArray(message.tasks) ?? [])
    .map((task) => asRecord(task))
    .filter((task): task is Record<string, unknown> => task !== undefined);
  const taskIds = tasks
    .map((task) => asString(task.task_id))
    .filter((taskId): taskId is string => taskId !== undefined);
  const transition = runtimeState.replaceBackgroundTaskMembership(taskIds);
  const byId = new Map(
    tasks.flatMap((task) => {
      const taskId = asString(task.task_id);
      return taskId ? [[taskId, task] as const] : [];
    }),
  );

  return transition.started.map((taskId) => {
    const task = byId.get(taskId);
    const existing = runtimeState.getTaskStatus(taskId);
    runtimeState.setTaskStatus(taskId, existing ?? "running");
    const sessionId = asString(message.session_id);
    const event: ClaudeClientEvent = {
      type: "claude_runtime_task_updated",
      taskId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      patch: {
        status: existing ?? "running",
        is_backgrounded: true,
        background_provenance: "sdk_membership",
        ...(asString(task?.tool_use_id) !== undefined
          ? { tool_use_id: asString(task?.tool_use_id) }
          : {}),
        ...(asString(task?.description) !== undefined
          ? { description: asString(task?.description) }
          : {}),
        ...(asString(task?.task_type) !== undefined
          ? { task_type: asString(task?.task_type) }
          : {}),
      },
    };
    attachClaudeBackgroundProvenance(event, "sdk_membership");
    return event;
  });
}
