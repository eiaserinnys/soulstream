import type { SSEEventPayload } from "../engine/protocol.js";

import type {
  ClaudeRuntimeNotificationState,
  ClaudeRuntimeRemoteTriggerState,
  ClaudeRuntimeSessionState,
  ClaudeRuntimeState,
  ClaudeRuntimeTranscriptMirrorState,
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

  if (eventType === "claude_runtime_mode_state") {
    const mode = asString(payload.mode);
    if (mode !== "plan" && mode !== "worktree") return true;
    const state = {
      active: payload.active === true,
      updatedAt: now,
      ...(parseModeSource(payload.source) !== undefined
        ? { source: parseModeSource(payload.source) }
        : {}),
      ...(asString(payload.tool_use_id) !== undefined
        ? { toolUseId: asString(payload.tool_use_id) }
        : {}),
      ...(asString(payload.tool_name) !== undefined ? { toolName: asString(payload.tool_name) } : {}),
      ...(asString(payload.worktree_name) !== undefined
        ? { worktreeName: asString(payload.worktree_name) }
        : {}),
      ...(asString(payload.worktree_path) !== undefined
        ? { worktreePath: asString(payload.worktree_path) }
        : {}),
      ...(asString(payload.worktree_action) !== undefined
        ? { worktreeAction: asString(payload.worktree_action) }
        : {}),
    };
    if (mode === "plan") {
      runtime.planMode = state;
    } else {
      runtime.worktreeMode = state;
    }
    const sessionId = asString(payload.session_id);
    if (sessionId) runtime.sessionId = sessionId;
    return true;
  }

  if (eventType === "claude_runtime_notification") {
    const notificationId = asString(payload.notification_id);
    const message = asString(payload.message);
    const source = parseNotificationSource(payload.source);
    if (!notificationId || !message || !source) return true;
    const notification: ClaudeRuntimeNotificationState = {
      ...(runtime.notifications?.[notificationId] ?? {}),
      notificationId,
      source,
      message,
      updatedAt: now,
    };
    copyString(payload, "title", notification);
    copyString(payload, "notification_type", notification, "notificationType");
    copyString(payload, "key", notification);
    copyString(payload, "priority", notification);
    copyString(payload, "tool_use_id", notification, "toolUseId");
    const sessionId = asString(payload.session_id);
    if (sessionId) {
      runtime.sessionId = sessionId;
      notification.sessionId = sessionId;
    }
    runtime.notifications = {
      ...(runtime.notifications ?? {}),
      [notificationId]: notification,
    };
    return true;
  }

  if (eventType === "claude_runtime_remote_trigger") {
    const triggerId = asString(payload.trigger_id);
    const source = parseRemoteTriggerSource(payload.source);
    if (!triggerId || !source) return true;
    const trigger: ClaudeRuntimeRemoteTriggerState = {
      ...(runtime.remoteTriggers?.[triggerId] ?? {}),
      triggerId,
      source,
      updatedAt: now,
    };
    copyString(payload, "origin_kind", trigger, "originKind");
    copyString(payload, "origin_from", trigger, "originFrom");
    copyString(payload, "origin_name", trigger, "originName");
    copyString(payload, "origin_server", trigger, "originServer");
    copyString(payload, "priority", trigger);
    copyString(payload, "prompt", trigger);
    copyString(payload, "trigger_type", trigger, "triggerType");
    copyString(payload, "tool_use_id", trigger, "toolUseId");
    const triggerPayload = asRecord(payload.payload);
    if (triggerPayload) trigger.payload = triggerPayload;
    const sessionId = asString(payload.session_id);
    if (sessionId) {
      runtime.sessionId = sessionId;
      trigger.sessionId = sessionId;
    }
    runtime.remoteTriggers = {
      ...(runtime.remoteTriggers ?? {}),
      [triggerId]: trigger,
    };
    return true;
  }

  if (eventType === "claude_runtime_transcript_mirror_error") {
    const mirror: ClaudeRuntimeTranscriptMirrorState = {
      ...(runtime.transcriptMirror ?? { errorCount: 0 }),
      updatedAt: now,
      errorCount: (runtime.transcriptMirror?.errorCount ?? 0) + 1,
    };
    copyString(payload, "mirror_id", mirror, "mirrorId");
    copyString(payload, "error", mirror, "lastError");
    copyString(payload, "project_key", mirror, "projectKey");
    copyString(payload, "transcript_session_id", mirror, "transcriptSessionId");
    copyString(payload, "subpath", mirror);
    const sessionId = asString(payload.session_id);
    if (sessionId) {
      runtime.sessionId = sessionId;
      mirror.sessionId = sessionId;
    }
    runtime.transcriptMirror = mirror;
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

    case "claude_runtime_task_created":
      runtimeTask.status = "pending";
      copyString(payload, "subject", runtimeTask);
      copyString(payload, "description", runtimeTask);
      copyString(payload, "teammate_name", runtimeTask, "teammateName");
      copyString(payload, "team_name", runtimeTask, "teamName");
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

    case "claude_runtime_task_completed":
      runtimeTask.status = "completed";
      copyString(payload, "subject", runtimeTask);
      copyString(payload, "description", runtimeTask);
      copyString(payload, "teammate_name", runtimeTask, "teammateName");
      copyString(payload, "team_name", runtimeTask, "teamName");
      break;

    case "claude_runtime_task_notification": {
      // Claude emits task_notification only for work detached into the background.
      // Local Agent notifications do not carry is_backgrounded, so the event type
      // itself is the canonical background signal.
      runtimeTask.isBackgrounded = true;
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
  return getBlockingClaudeRuntimeWork(task) !== null;
}

export function failBlockingClaudeRuntimeWork(
  task: Task,
  message: string,
): ClaudeRuntimeTaskState[] {
  const runtime = task.claudeRuntime;
  const blocking = getBlockingClaudeRuntimeWork(task);
  if (!runtime || !blocking) return [];

  const now = Date.now();
  runtime.updatedAt = now;
  if (runtime.sessionState && runtime.sessionState !== "idle") {
    runtime.sessionState = "idle";
  }
  for (const runtimeTask of blocking.foregroundTasks) {
    runtimeTask.status = "failed";
    runtimeTask.error = message;
    runtimeTask.updatedAt = now;
  }
  return blocking.foregroundTasks;
}

function getBlockingClaudeRuntimeWork(task: Task): {
  sessionState?: ClaudeRuntimeSessionState;
  foregroundTasks: ClaudeRuntimeTaskState[];
} | null {
  const runtime = task.claudeRuntime;
  if (!runtime) return null;
  const sessionState = runtime.sessionState && runtime.sessionState !== "idle"
    ? runtime.sessionState
    : undefined;
  if (!sessionState) return null;

  const foregroundTasks = Object.values(runtime.tasks).filter(
    (runtimeTask) =>
      runtimeTask.isBackgrounded !== true &&
      !TERMINAL_CLAUDE_RUNTIME_TASK_STATUSES.has(runtimeTask.status),
  );
  return { sessionState, foregroundTasks };
}

function ensureClaudeRuntimeState(task: Task): ClaudeRuntimeState {
  if (!task.claudeRuntime) {
    task.claudeRuntime = {
      updatedAt: Date.now(),
      tasks: {},
      notifications: {},
      remoteTriggers: {},
    };
  }
  task.claudeRuntime.notifications ??= {};
  task.claudeRuntime.remoteTriggers ??= {};
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

function parseModeSource(value: unknown): "hook" | "tool_use" | undefined {
  return value === "hook" || value === "tool_use" ? value : undefined;
}

function parseNotificationSource(value: unknown): "hook" | "system" | "tool_use" | undefined {
  return value === "hook" || value === "system" || value === "tool_use" ? value : undefined;
}

function parseRemoteTriggerSource(value: unknown): "message_origin" | "tool_use" | undefined {
  return value === "message_origin" || value === "tool_use" ? value : undefined;
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
