import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import { attachClaudeBackgroundProvenance } from
  "./claude_background_provenance.js";
import { extractBackgroundBashOutput } from "./claude_sdk_event_mapper_helpers.js";
import {
  asArray,
  asRecord,
  asString,
} from "./claude_sdk_helpers.js";
import type { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";

export type ClaudeParentIngressScope = "top_level" | "sidechain" | "unknown";

type ClaudeParentTaskScope = {
  linkTaskToTool(taskId: string, toolUseId: string): void;
  isParentTaskEligible(taskId: string): boolean;
};

/**
 * Tracks the two authoritative ancestry joins used by SDK task messages.
 * System messages deliberately cannot create scope because the SDK does not
 * expose parent ancestry on those message types.
 */
export class ClaudeParentIngressScopeTracker {
  private readonly toolScopesById = new Map<string, ClaudeParentIngressScope>();
  private readonly taskScopesById = new Map<
    string,
    { scope: ClaudeParentIngressScope; toolUseId?: string }
  >();

  clear(): void {
    this.toolScopesById.clear();
    this.taskScopesById.clear();
  }

  recordMessageToolScope(toolUseId: string, message: Record<string, unknown>): void {
    this.recordToolScope(toolUseId, messageParentScope(message));
  }

  recordHookToolScope(toolUseId: string | undefined, agentId: string | undefined): void {
    if (toolUseId) this.recordToolScope(toolUseId, agentId ? "sidechain" : "top_level");
  }

  recordHookTaskScope(taskId: string, agentId: string | undefined): void {
    this.recordTaskScope(taskId, agentId ? "sidechain" : "top_level");
  }

  linkTaskToTool(taskId: string, toolUseId: string): void {
    const current = this.taskScopesById.get(taskId);
    this.taskScopesById.set(taskId, {
      scope: current?.scope ?? "unknown",
      toolUseId,
    });
  }

  isParentTaskEligible(taskId: string): boolean {
    const task = this.taskScopesById.get(taskId);
    return mergeScope(
      task?.scope,
      task?.toolUseId ? this.toolScopesById.get(task.toolUseId) ?? "unknown" : "unknown",
    ) === "top_level";
  }

  private recordToolScope(toolUseId: string, scope: ClaudeParentIngressScope): void {
    this.toolScopesById.set(toolUseId, mergeScope(this.toolScopesById.get(toolUseId), scope));
  }

  private recordTaskScope(taskId: string, scope: ClaudeParentIngressScope): void {
    const current = this.taskScopesById.get(taskId);
    this.taskScopesById.set(taskId, {
      scope: mergeScope(current?.scope, scope),
      ...(current?.toolUseId ? { toolUseId: current.toolUseId } : {}),
    });
  }
}

export function mapClaudeBackgroundBashTaskFromToolResult(
  params: { toolName?: string; toolUseId: string | null; content: unknown },
  runtimeState: ClaudeRuntimeState,
  scope: ClaudeParentTaskScope,
): ClaudeClientEvent[] {
  const background = extractBackgroundBashOutput(params.content);
  if (!background.taskId) return [];
  if (params.toolName && params.toolName !== "Bash" && params.toolName !== "bash") return [];

  const patch: Record<string, unknown> = {
    status: "running",
    is_backgrounded: true,
    task_type: "bash",
  };
  if (params.toolUseId) patch.tool_use_id = params.toolUseId;
  if (background.outputFile) patch.output_file = background.outputFile;

  const existing = runtimeState.getTaskStatus(background.taskId);
  runtimeState.setTaskStatus(background.taskId, existing ?? "running");
  runtimeState.markBackgroundTask(background.taskId);
  if (params.toolUseId) scope.linkTaskToTool(background.taskId, params.toolUseId);
  if (!scope.isParentTaskEligible(background.taskId)) return [];

  const updateEvent: ClaudeClientEvent = {
    type: "claude_runtime_task_updated",
    taskId: background.taskId,
    patch,
  };
  const events: ClaudeClientEvent[] = existing
    ? [updateEvent]
    : [
        {
          type: "claude_runtime_task_started",
          taskId: background.taskId,
          ...(params.toolUseId ? { toolUseId: params.toolUseId } : {}),
          taskType: "bash",
          description: "Background Bash task",
        },
        updateEvent,
      ];
  for (const event of events) {
    attachClaudeBackgroundProvenance(event, "explicit_background_tool_result");
  }
  return events;
}

/**
 * Maps the SDK's authoritative background membership snapshot into runtime
 * events. Keeping this boundary separate prevents ordinary synchronous task
 * notifications from being inferred as background work downstream.
 */
export function mapClaudeBackgroundTaskMembership(
  message: Record<string, unknown>,
  runtimeState: ClaudeRuntimeState,
  scope: ClaudeParentTaskScope,
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

  for (const [taskId, task] of byId) {
    const toolUseId = asString(task.tool_use_id);
    if (toolUseId) scope.linkTaskToTool(taskId, toolUseId);
    runtimeState.setTaskStatus(taskId, runtimeState.getTaskStatus(taskId) ?? "running");
  }

  return transition.started.filter((taskId) => scope.isParentTaskEligible(taskId)).map((taskId) => {
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

function messageParentScope(message: Record<string, unknown>): ClaudeParentIngressScope {
  if (!Object.prototype.hasOwnProperty.call(message, "parent_tool_use_id")) return "unknown";
  if (message.parent_tool_use_id === null) return "top_level";
  return asString(message.parent_tool_use_id) ? "sidechain" : "unknown";
}

function mergeScope(
  current: ClaudeParentIngressScope | undefined,
  incoming: ClaudeParentIngressScope,
): ClaudeParentIngressScope {
  if (current === "sidechain" || incoming === "sidechain") return "sidechain";
  if (current === "top_level" || incoming === "top_level") return "top_level";
  return "unknown";
}
