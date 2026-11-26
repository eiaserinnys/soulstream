import type { ClaudeRuntimeTaskStatus } from "../../../wire-schema/generated/typescript/index";

export interface ClaudeRuntimeTaskView {
  taskId: string;
  status: ClaudeRuntimeTaskStatus;
  updatedAt: number;
  sessionId?: string;
  toolUseId?: string;
  description?: string;
  taskType?: string;
  workflowName?: string;
  subject?: string;
  teammateName?: string;
  teamName?: string;
  prompt?: string;
  skipTranscript?: boolean;
  outputFile?: string;
  summary?: string;
  usage?: Record<string, unknown>;
  lastToolName?: string;
  error?: string;
  isBackgrounded?: boolean;
  closeReason?: string;
  endTime?: number;
  totalPausedMs?: number;
}

export type ClaudeRuntimeScheduleKind = "wakeup" | "cron";

export type ClaudeRuntimeScheduleStatus =
  | "active"
  | "dispatching"
  | "firing"
  | "completed"
  | "cancelled"
  | "failed"
  | "orphaned";

export interface ClaudeRuntimeScheduleView {
  scheduleId: string;
  sessionId?: string;
  kind: ClaudeRuntimeScheduleKind;
  status: ClaudeRuntimeScheduleStatus;
  prompt?: string;
  sourceTool?: string;
  toolUseId?: string | null;
  cronExpression?: string | null;
  runOnceAt?: string | null;
  timezone?: string;
  recurring?: boolean;
  nextRunAt?: string | null;
  lastFiredAt?: string | null;
  firedCount?: number;
  lastError?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ClaudeRuntimeModeView {
  active: boolean;
  updatedAt: number;
  source?: "hook" | "tool_use";
  toolUseId?: string;
  toolName?: string;
  worktreeName?: string;
  worktreePath?: string;
  worktreeAction?: string;
}

export interface ClaudeRuntimeNotificationView {
  notificationId: string;
  source: "hook" | "system" | "tool_use";
  message: string;
  updatedAt: number;
  title?: string;
  notificationType?: string;
  key?: string;
  priority?: string;
  sessionId?: string;
  toolUseId?: string;
}

export interface ClaudeRuntimeRemoteTriggerView {
  triggerId: string;
  source: "message_origin" | "tool_use";
  updatedAt: number;
  sessionId?: string;
  toolUseId?: string;
  originKind?: string;
  originFrom?: string;
  originName?: string;
  originServer?: string;
  priority?: string;
  prompt?: string;
  triggerType?: string;
  payload?: Record<string, unknown>;
}

export interface ClaudeRuntimeTranscriptMirrorView {
  updatedAt: number;
  errorCount: number;
  lastError?: string;
  mirrorId?: string;
  sessionId?: string;
  projectKey?: string;
  transcriptSessionId?: string;
  subpath?: string;
}

export interface ClaudeRuntimeView {
  sessionState?: "idle" | "running" | "requires_action";
  runtimeSessionId?: string;
  updatedAt: number;
  tasks: Record<string, ClaudeRuntimeTaskView>;
  schedules: Record<string, ClaudeRuntimeScheduleView>;
  notifications: Record<string, ClaudeRuntimeNotificationView>;
  remoteTriggers: Record<string, ClaudeRuntimeRemoteTriggerView>;
  transcriptMirror?: ClaudeRuntimeTranscriptMirrorView | null;
  planMode?: ClaudeRuntimeModeView | null;
  worktreeMode?: ClaudeRuntimeModeView | null;
  nextScheduleRunAt?: string | null;
}

export function applyClaudeRuntimeEvent<E extends { type: string }>(
  current: ClaudeRuntimeView | null,
  event: E,
): ClaudeRuntimeView | null {
  if (!event.type.startsWith("claude_runtime_")) return current;
  if (event.type === "claude_runtime_hook_event") return current;

  const payload = event as unknown as Record<string, unknown>;
  const updatedAt = timestampToMs(payload.timestamp);
  const next: ClaudeRuntimeView = {
    ...(current ?? { tasks: {}, schedules: {}, notifications: {}, remoteTriggers: {}, updatedAt }),
    tasks: { ...(current?.tasks ?? {}) },
    schedules: { ...(current?.schedules ?? {}) },
    notifications: { ...(current?.notifications ?? {}) },
    remoteTriggers: { ...(current?.remoteTriggers ?? {}) },
    updatedAt,
  };

  if (event.type === "claude_runtime_session_state") {
    next.sessionState = payload.state as ClaudeRuntimeView["sessionState"];
    if (payload.session_id) next.runtimeSessionId = payload.session_id as string;
    return next;
  }

  if (event.type === "claude_runtime_schedule_updated") {
    const scheduleId = payload.schedule_id as string | undefined;
    if (!scheduleId) return next;
    const schedule = scheduleFromEvent(scheduleId, payload);
    next.schedules[scheduleId] = schedule;
    next.nextScheduleRunAt = computeNextScheduleRunAt(next.schedules);
    return next;
  }

  if (event.type === "claude_runtime_schedule_deleted") {
    const scheduleId = payload.schedule_id as string | undefined;
    if (!scheduleId) return next;
    delete next.schedules[scheduleId];
    next.nextScheduleRunAt = computeNextScheduleRunAt(next.schedules);
    return next;
  }

  if (event.type === "claude_runtime_mode_state") {
    const mode = payload.mode;
    if (mode !== "plan" && mode !== "worktree") return next;
    const modeState: ClaudeRuntimeModeView = {
      active: payload.active === true,
      updatedAt,
    };
    if (payload.source === "hook" || payload.source === "tool_use") {
      modeState.source = payload.source;
    }
    copyString(payload, "tool_use_id", modeState, "toolUseId");
    copyString(payload, "tool_name", modeState, "toolName");
    copyString(payload, "worktree_name", modeState, "worktreeName");
    copyString(payload, "worktree_path", modeState, "worktreePath");
    copyString(payload, "worktree_action", modeState, "worktreeAction");
    if (mode === "plan") {
      next.planMode = modeState;
    } else {
      next.worktreeMode = modeState;
    }
    return next;
  }

  if (event.type === "claude_runtime_notification") {
    const notificationId = payload.notification_id as string;
    const notification: ClaudeRuntimeNotificationView = {
      ...(next.notifications[notificationId] ?? {}),
      notificationId,
      source: payload.source as ClaudeRuntimeNotificationView["source"],
      message: payload.message as string,
      updatedAt,
    };
    copyString(payload, "title", notification);
    copyString(payload, "notification_type", notification, "notificationType");
    copyString(payload, "key", notification);
    copyString(payload, "priority", notification);
    copyString(payload, "session_id", notification, "sessionId");
    copyString(payload, "tool_use_id", notification, "toolUseId");
    if (payload.session_id) next.runtimeSessionId = payload.session_id as string;
    next.notifications[notificationId] = notification;
    return next;
  }

  if (event.type === "claude_runtime_remote_trigger") {
    const triggerId = payload.trigger_id as string;
    const trigger: ClaudeRuntimeRemoteTriggerView = {
      ...(next.remoteTriggers[triggerId] ?? {}),
      triggerId,
      source: payload.source as ClaudeRuntimeRemoteTriggerView["source"],
      updatedAt,
    };
    copyString(payload, "session_id", trigger, "sessionId");
    copyString(payload, "tool_use_id", trigger, "toolUseId");
    copyString(payload, "origin_kind", trigger, "originKind");
    copyString(payload, "origin_from", trigger, "originFrom");
    copyString(payload, "origin_name", trigger, "originName");
    copyString(payload, "origin_server", trigger, "originServer");
    copyString(payload, "priority", trigger);
    copyString(payload, "prompt", trigger);
    copyString(payload, "trigger_type", trigger, "triggerType");
    if (payload.payload && typeof payload.payload === "object") {
      trigger.payload = payload.payload as Record<string, unknown>;
    }
    if (payload.session_id) next.runtimeSessionId = payload.session_id as string;
    next.remoteTriggers[triggerId] = trigger;
    return next;
  }

  if (event.type === "claude_runtime_transcript_mirror_error") {
    next.transcriptMirror = {
      ...(next.transcriptMirror ?? { errorCount: 0 }),
      updatedAt,
      errorCount: (next.transcriptMirror?.errorCount ?? 0) + 1,
      mirrorId: payload.mirror_id as string,
      sessionId: payload.session_id as string,
      projectKey: payload.project_key as string,
      transcriptSessionId: payload.transcript_session_id as string,
      subpath: payload.subpath as string,
      lastError: payload.error as string,
    };
    if (payload.session_id) next.runtimeSessionId = payload.session_id as string;
    return next;
  }

  const taskId = payload.task_id as string | undefined;
  if (!taskId) return next;
  const existing = next.tasks[taskId];
  const runtimeTask: ClaudeRuntimeTaskView = {
    ...(existing ?? { taskId, status: "pending" as const, updatedAt }),
    taskId,
    updatedAt,
  };

  if (typeof payload.session_id === "string" && payload.session_id) {
    next.runtimeSessionId = payload.session_id;
    runtimeTask.sessionId = payload.session_id;
  }
  if (typeof payload.tool_use_id === "string" && payload.tool_use_id) {
    runtimeTask.toolUseId = payload.tool_use_id;
  }

  switch (event.type) {
    case "claude_runtime_task_started":
      runtimeTask.status = "running";
      copyString(payload, "description", runtimeTask);
      copyString(payload, "task_type", runtimeTask, "taskType");
      copyString(payload, "workflow_name", runtimeTask, "workflowName");
      copyString(payload, "prompt", runtimeTask);
      if (typeof payload.skip_transcript === "boolean") {
        runtimeTask.skipTranscript = payload.skip_transcript;
      }
      break;
    case "claude_runtime_task_created":
      runtimeTask.status = "pending";
      copyString(payload, "subject", runtimeTask);
      copyString(payload, "description", runtimeTask);
      copyString(payload, "teammate_name", runtimeTask, "teammateName");
      copyString(payload, "team_name", runtimeTask, "teamName");
      break;
    case "claude_runtime_task_updated": {
      const patch = (payload.patch ?? {}) as Record<string, unknown>;
      if (isTaskStatus(patch.status)) runtimeTask.status = patch.status;
      copyString(patch, "tool_use_id", runtimeTask, "toolUseId");
      copyString(patch, "description", runtimeTask);
      copyString(patch, "task_type", runtimeTask, "taskType");
      copyString(patch, "output_file", runtimeTask, "outputFile");
      copyString(patch, "summary", runtimeTask);
      copyString(patch, "error", runtimeTask);
      copyString(patch, "close_reason", runtimeTask, "closeReason");
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
      copyString(payload, "description", runtimeTask);
      copyString(payload, "last_tool_name", runtimeTask, "lastToolName");
      copyString(payload, "summary", runtimeTask);
      if (payload.usage && typeof payload.usage === "object") {
        runtimeTask.usage = payload.usage as Record<string, unknown>;
      }
      break;
    case "claude_runtime_task_completed":
      runtimeTask.status = "completed";
      copyString(payload, "subject", runtimeTask);
      copyString(payload, "description", runtimeTask);
      copyString(payload, "teammate_name", runtimeTask, "teammateName");
      copyString(payload, "team_name", runtimeTask, "teamName");
      break;
    case "claude_runtime_task_notification":
      runtimeTask.status = payload.status as ClaudeRuntimeTaskStatus;
      copyString(payload, "output_file", runtimeTask, "outputFile");
      copyString(payload, "summary", runtimeTask);
      if (typeof payload.skip_transcript === "boolean") {
        runtimeTask.skipTranscript = payload.skip_transcript;
      }
      if (payload.usage && typeof payload.usage === "object") {
        runtimeTask.usage = payload.usage as Record<string, unknown>;
      }
      break;
  }

  next.tasks[taskId] = runtimeTask;
  return next;
}

function timestampToMs(value: unknown): number {
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

function scheduleFromEvent(
  scheduleId: string,
  payload: Record<string, unknown>,
): ClaudeRuntimeScheduleView {
  const schedule: ClaudeRuntimeScheduleView = {
    scheduleId,
    kind: isScheduleKind(payload.schedule_kind)
      ? payload.schedule_kind
      : "wakeup",
    status: isScheduleStatus(payload.status)
      ? payload.status
      : "active",
  };
  copyString(payload, "session_id", schedule, "sessionId");
  copyString(payload, "prompt", schedule);
  copyString(payload, "source_tool", schedule, "sourceTool");
  copyNullableString(payload, "tool_use_id", schedule, "toolUseId");
  copyNullableString(payload, "cron_expression", schedule, "cronExpression");
  copyNullableString(payload, "run_once_at", schedule, "runOnceAt");
  copyString(payload, "timezone", schedule);
  if (typeof payload.recurring === "boolean") schedule.recurring = payload.recurring;
  copyNullableString(payload, "next_run_at", schedule, "nextRunAt");
  copyNullableString(payload, "last_fired_at", schedule, "lastFiredAt");
  if (typeof payload.fired_count === "number") schedule.firedCount = payload.fired_count;
  copyNullableString(payload, "last_error", schedule, "lastError");
  copyString(payload, "created_at", schedule, "createdAt");
  copyString(payload, "updated_at", schedule, "updatedAt");
  return schedule;
}

function computeNextScheduleRunAt(
  schedules: Record<string, ClaudeRuntimeScheduleView>,
): string | null {
  const values = Object.values(schedules)
    .filter((schedule) => schedule.status === "active")
    .map((schedule) => schedule.nextRunAt)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort();
  return values[0] ?? null;
}

function isScheduleKind(value: unknown): value is ClaudeRuntimeScheduleKind {
  return value === "wakeup" || value === "cron";
}

function isScheduleStatus(value: unknown): value is ClaudeRuntimeScheduleStatus {
  return (
    value === "active" ||
    value === "dispatching" ||
    value === "firing" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "failed" ||
    value === "orphaned"
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

function copyNullableString<T extends object>(
  source: object,
  from: string,
  target: T,
  to: string = from,
): void {
  const value = (source as Record<string, unknown>)[from];
  if (typeof value === "string" || value === null) {
    (target as Record<string, unknown>)[to] = value;
  }
}
