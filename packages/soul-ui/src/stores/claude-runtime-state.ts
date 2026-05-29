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

export function applyClaudeRuntimeStoreEvent(
  current: ClaudeRuntimeView | null,
  event: SoulSSEEvent,
): ClaudeRuntimeView | null {
  if (!event.type.startsWith("claude_runtime_")) return current;
  if (event.type === "claude_runtime_hook_event") return current;

  const updatedAt = timestampToMs((event as { timestamp?: number }).timestamp);
  const next: ClaudeRuntimeView = {
    ...(current ?? { tasks: {}, schedules: {}, notifications: {}, remoteTriggers: {}, updatedAt }),
    tasks: { ...(current?.tasks ?? {}) },
    schedules: { ...(current?.schedules ?? {}) },
    notifications: { ...(current?.notifications ?? {}) },
    remoteTriggers: { ...(current?.remoteTriggers ?? {}) },
    updatedAt,
  };

  if (event.type === "claude_runtime_session_state") {
    next.sessionState = event.state;
    if (event.session_id) next.runtimeSessionId = event.session_id;
    return next;
  }

  if (event.type === "claude_runtime_schedule_updated") {
    const scheduleId = (event as { schedule_id?: string }).schedule_id;
    if (!scheduleId) return next;
    const schedule = scheduleFromEvent(scheduleId, event);
    next.schedules[scheduleId] = schedule;
    next.nextScheduleRunAt = computeNextScheduleRunAt(next.schedules);
    return next;
  }

  if (event.type === "claude_runtime_schedule_deleted") {
    const scheduleId = (event as { schedule_id?: string }).schedule_id;
    if (!scheduleId) return next;
    delete next.schedules[scheduleId];
    next.nextScheduleRunAt = computeNextScheduleRunAt(next.schedules);
    return next;
  }

  if (event.type === "claude_runtime_mode_state") {
    const payload = event as unknown as Record<string, unknown>;
    const mode = payload.mode;
    if (mode !== "plan" && mode !== "worktree") return next;
    const modeState: ClaudeRuntimeModeView = {
      active: payload.active === true,
      updatedAt,
    };
    if (payload.source === "hook" || payload.source === "tool_use") {
      modeState.source = payload.source;
    }
    copyString(event, "tool_use_id", modeState, "toolUseId");
    copyString(event, "tool_name", modeState, "toolName");
    copyString(event, "worktree_name", modeState, "worktreeName");
    copyString(event, "worktree_path", modeState, "worktreePath");
    copyString(event, "worktree_action", modeState, "worktreeAction");
    if (mode === "plan") {
      next.planMode = modeState;
    } else {
      next.worktreeMode = modeState;
    }
    return next;
  }

  if (event.type === "claude_runtime_notification") {
    const notificationId = event.notification_id;
    const notification: ClaudeRuntimeNotificationView = {
      ...(next.notifications[notificationId] ?? {}),
      notificationId,
      source: event.source,
      message: event.message,
      updatedAt,
    };
    copyString(event, "title", notification);
    copyString(event, "notification_type", notification, "notificationType");
    copyString(event, "key", notification);
    copyString(event, "priority", notification);
    copyString(event, "session_id", notification, "sessionId");
    copyString(event, "tool_use_id", notification, "toolUseId");
    if (event.session_id) next.runtimeSessionId = event.session_id;
    next.notifications[notificationId] = notification;
    return next;
  }

  if (event.type === "claude_runtime_remote_trigger") {
    const triggerId = event.trigger_id;
    const trigger: ClaudeRuntimeRemoteTriggerView = {
      ...(next.remoteTriggers[triggerId] ?? {}),
      triggerId,
      source: event.source,
      updatedAt,
    };
    copyString(event, "session_id", trigger, "sessionId");
    copyString(event, "tool_use_id", trigger, "toolUseId");
    copyString(event, "origin_kind", trigger, "originKind");
    copyString(event, "origin_from", trigger, "originFrom");
    copyString(event, "origin_name", trigger, "originName");
    copyString(event, "origin_server", trigger, "originServer");
    copyString(event, "priority", trigger);
    copyString(event, "prompt", trigger);
    copyString(event, "trigger_type", trigger, "triggerType");
    if (event.payload && typeof event.payload === "object") {
      trigger.payload = event.payload;
    }
    if (event.session_id) next.runtimeSessionId = event.session_id;
    next.remoteTriggers[triggerId] = trigger;
    return next;
  }

  if (event.type === "claude_runtime_transcript_mirror_error") {
    next.transcriptMirror = {
      ...(next.transcriptMirror ?? { errorCount: 0 }),
      updatedAt,
      errorCount: (next.transcriptMirror?.errorCount ?? 0) + 1,
      mirrorId: event.mirror_id,
      sessionId: event.session_id,
      projectKey: event.project_key,
      transcriptSessionId: event.transcript_session_id,
      subpath: event.subpath,
      lastError: event.error,
    };
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
    case "claude_runtime_task_created":
      runtimeTask.status = "pending";
      copyString(event, "subject", runtimeTask);
      copyString(event, "description", runtimeTask);
      copyString(event, "teammate_name", runtimeTask, "teammateName");
      copyString(event, "team_name", runtimeTask, "teamName");
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
    case "claude_runtime_task_completed":
      runtimeTask.status = "completed";
      copyString(event, "subject", runtimeTask);
      copyString(event, "description", runtimeTask);
      copyString(event, "teammate_name", runtimeTask, "teammateName");
      copyString(event, "team_name", runtimeTask, "teamName");
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

export function schedulesFromList(
  schedules: ClaudeRuntimeScheduleView[],
): Record<string, ClaudeRuntimeScheduleView> {
  return Object.fromEntries(schedules.map((schedule) => [schedule.scheduleId, schedule]));
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

function scheduleFromEvent(
  scheduleId: string,
  event: SoulSSEEvent,
): ClaudeRuntimeScheduleView {
  const payload = event as unknown as Record<string, unknown>;
  const existing = {};
  const schedule: ClaudeRuntimeScheduleView = {
    ...existing,
    scheduleId,
    kind: isScheduleKind(payload.schedule_kind)
      ? payload.schedule_kind
      : "wakeup",
    status: isScheduleStatus(payload.status)
      ? payload.status
      : "active",
  };
  copyString(event, "session_id", schedule, "sessionId");
  copyString(event, "prompt", schedule);
  copyString(event, "source_tool", schedule, "sourceTool");
  copyNullableString(event, "tool_use_id", schedule, "toolUseId");
  copyNullableString(event, "cron_expression", schedule, "cronExpression");
  copyNullableString(event, "run_once_at", schedule, "runOnceAt");
  copyString(event, "timezone", schedule);
  if (typeof payload.recurring === "boolean") schedule.recurring = payload.recurring;
  copyNullableString(event, "next_run_at", schedule, "nextRunAt");
  copyNullableString(event, "last_fired_at", schedule, "lastFiredAt");
  if (typeof payload.fired_count === "number") schedule.firedCount = payload.fired_count;
  copyNullableString(event, "last_error", schedule, "lastError");
  copyString(event, "created_at", schedule, "createdAt");
  copyString(event, "updated_at", schedule, "updatedAt");
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
