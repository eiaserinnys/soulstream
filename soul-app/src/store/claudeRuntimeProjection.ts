import type {
  ClaudeRuntimeMode,
  ClaudeRuntimeNotification,
  ClaudeRuntimeRemoteTrigger,
  ClaudeRuntimeTask,
  ClaudeRuntimeTaskStatus,
  ClaudeRuntimeSchedule,
  ClaudeRuntimeScheduleKind,
  ClaudeRuntimeScheduleStatus,
  ClaudeRuntimeTranscriptMirror,
} from '../api/types';

export interface ClaudeRuntimeView {
  sessionState?: 'idle' | 'running' | 'requires_action';
  runtimeSessionId?: string;
  updatedAt: number;
  tasks: Record<string, ClaudeRuntimeTask>;
  schedules: Record<string, ClaudeRuntimeSchedule>;
  notifications: Record<string, ClaudeRuntimeNotification>;
  remoteTriggers: Record<string, ClaudeRuntimeRemoteTrigger>;
  transcriptMirror?: ClaudeRuntimeTranscriptMirror | null;
  planMode?: ClaudeRuntimeMode | null;
  worktreeMode?: ClaudeRuntimeMode | null;
  nextScheduleRunAt?: string | null;
}

export function applyClaudeRuntimePayload(
  current: ClaudeRuntimeView | undefined,
  type: string,
  data: unknown,
): ClaudeRuntimeView | undefined {
  if (!type.startsWith('claude_runtime_')) return current;
  if (type === 'claude_runtime_hook_event') return current;
  const payload = asRecord(data);
  if (!payload) return current;
  const updatedAt = timestampToMs(payload.timestamp);
  const next: ClaudeRuntimeView = {
    ...(current ?? {
      tasks: {},
      schedules: {},
      notifications: {},
      remoteTriggers: {},
      updatedAt,
    }),
    tasks: { ...(current?.tasks ?? {}) },
    schedules: { ...(current?.schedules ?? {}) },
    notifications: { ...(current?.notifications ?? {}) },
    remoteTriggers: { ...(current?.remoteTriggers ?? {}) },
    updatedAt,
  };
  if (type === 'claude_runtime_session_state') {
    const state = asSessionState(payload.state);
    if (state) next.sessionState = state;
    const sessionId = asString(payload.session_id);
    if (sessionId) next.runtimeSessionId = sessionId;
    return next;
  }
  if (type === 'claude_runtime_schedule_updated') {
    const scheduleId = asString(payload.schedule_id);
    if (!scheduleId) return next;
    const schedule = scheduleFromPayload(scheduleId, payload);
    next.schedules[scheduleId] = schedule;
    next.nextScheduleRunAt = computeNextScheduleRunAt(next.schedules);
    return next;
  }
  if (type === 'claude_runtime_schedule_deleted') {
    const scheduleId = asString(payload.schedule_id);
    if (!scheduleId) return next;
    delete next.schedules[scheduleId];
    next.nextScheduleRunAt = computeNextScheduleRunAt(next.schedules);
    return next;
  }
  if (type === 'claude_runtime_mode_state') {
    const mode = payload.mode;
    if (mode !== 'plan' && mode !== 'worktree') return next;
    const modeState: ClaudeRuntimeMode = {
      active: payload.active === true,
      updatedAt,
    };
    if (payload.source === 'hook' || payload.source === 'tool_use') {
      modeState.source = payload.source;
    }
    copyString(payload, 'tool_use_id', modeState, 'toolUseId');
    copyString(payload, 'tool_name', modeState, 'toolName');
    copyString(payload, 'worktree_name', modeState, 'worktreeName');
    copyString(payload, 'worktree_path', modeState, 'worktreePath');
    copyString(payload, 'worktree_action', modeState, 'worktreeAction');
    if (mode === 'plan') {
      next.planMode = modeState;
    } else {
      next.worktreeMode = modeState;
    }
    return next;
  }
  if (type === 'claude_runtime_notification') {
    const notificationId = asString(payload.notification_id);
    const source = asNotificationSource(payload.source);
    const message = asString(payload.message);
    if (!notificationId || !source || !message) return next;
    const notification: ClaudeRuntimeNotification = {
      ...(next.notifications[notificationId] ?? {}),
      notificationId,
      source,
      message,
      updatedAt,
    };
    copyString(payload, 'title', notification);
    copyString(payload, 'notification_type', notification, 'notificationType');
    copyString(payload, 'key', notification);
    copyString(payload, 'priority', notification);
    copyString(payload, 'session_id', notification, 'sessionId');
    copyString(payload, 'tool_use_id', notification, 'toolUseId');
    const sessionId = asString(payload.session_id);
    if (sessionId) next.runtimeSessionId = sessionId;
    next.notifications[notificationId] = notification;
    return next;
  }
  if (type === 'claude_runtime_remote_trigger') {
    const triggerId = asString(payload.trigger_id);
    const source = asRemoteTriggerSource(payload.source);
    if (!triggerId || !source) return next;
    const trigger: ClaudeRuntimeRemoteTrigger = {
      ...(next.remoteTriggers[triggerId] ?? {}),
      triggerId,
      source,
      updatedAt,
    };
    copyString(payload, 'session_id', trigger, 'sessionId');
    copyString(payload, 'tool_use_id', trigger, 'toolUseId');
    copyString(payload, 'origin_kind', trigger, 'originKind');
    copyString(payload, 'origin_from', trigger, 'originFrom');
    copyString(payload, 'origin_name', trigger, 'originName');
    copyString(payload, 'origin_server', trigger, 'originServer');
    copyString(payload, 'priority', trigger);
    copyString(payload, 'prompt', trigger);
    copyString(payload, 'trigger_type', trigger, 'triggerType');
    if (payload.payload && typeof payload.payload === 'object') {
      trigger.payload = payload.payload as Record<string, unknown>;
    }
    const sessionId = asString(payload.session_id);
    if (sessionId) next.runtimeSessionId = sessionId;
    next.remoteTriggers[triggerId] = trigger;
    return next;
  }
  if (type === 'claude_runtime_transcript_mirror_error') {
    const error = asString(payload.error);
    if (!error) return next;
    next.transcriptMirror = {
      ...(next.transcriptMirror ?? { errorCount: 0, updatedAt }),
      updatedAt,
      errorCount: (next.transcriptMirror?.errorCount ?? 0) + 1,
      lastError: error,
      mirrorId: asString(payload.mirror_id),
      sessionId: asString(payload.session_id),
      projectKey: asString(payload.project_key),
      transcriptSessionId: asString(payload.transcript_session_id),
      subpath: asString(payload.subpath),
    };
    const sessionId = asString(payload.session_id);
    if (sessionId) next.runtimeSessionId = sessionId;
    return next;
  }
  const taskId = asString(payload.task_id);
  if (!taskId) return next;
  const existing = next.tasks[taskId];
  const runtimeTask: ClaudeRuntimeTask = {
    ...(existing ?? { taskId, status: 'pending' as const, updatedAt }),
    taskId,
    updatedAt,
  };
  const sessionId = asString(payload.session_id);
  if (sessionId) {
    next.runtimeSessionId = sessionId;
    runtimeTask.sessionId = sessionId;
  }
  const toolUseId = asString(payload.tool_use_id);
  if (toolUseId) runtimeTask.toolUseId = toolUseId;

  if (type === 'claude_runtime_task_started') {
    runtimeTask.status = 'running';
    copyString(payload, 'description', runtimeTask);
    copyString(payload, 'task_type', runtimeTask, 'taskType');
    copyString(payload, 'workflow_name', runtimeTask, 'workflowName');
    copyString(payload, 'prompt', runtimeTask);
    if (typeof payload.skip_transcript === 'boolean') {
      runtimeTask.skipTranscript = payload.skip_transcript;
    }
  } else if (type === 'claude_runtime_task_created') {
    runtimeTask.status = 'pending';
    copyString(payload, 'subject', runtimeTask);
    copyString(payload, 'description', runtimeTask);
    copyString(payload, 'teammate_name', runtimeTask, 'teammateName');
    copyString(payload, 'team_name', runtimeTask, 'teamName');
  } else if (type === 'claude_runtime_task_updated') {
    const patch = asRecord(payload.patch) ?? {};
    const status = asTaskStatus(patch.status);
    if (status) runtimeTask.status = status;
    copyString(patch, 'tool_use_id', runtimeTask, 'toolUseId');
    copyString(patch, 'description', runtimeTask);
    copyString(patch, 'task_type', runtimeTask, 'taskType');
    copyString(patch, 'output_file', runtimeTask, 'outputFile');
    copyString(patch, 'summary', runtimeTask);
    copyString(patch, 'error', runtimeTask);
    if (typeof patch.is_backgrounded === 'boolean') {
      runtimeTask.isBackgrounded = patch.is_backgrounded;
    }
    if (typeof patch.end_time === 'number') runtimeTask.endTime = patch.end_time;
    if (typeof patch.total_paused_ms === 'number') {
      runtimeTask.totalPausedMs = patch.total_paused_ms;
    }
  } else if (type === 'claude_runtime_task_progress') {
    runtimeTask.status = 'running';
    copyString(payload, 'description', runtimeTask);
    copyString(payload, 'last_tool_name', runtimeTask, 'lastToolName');
    copyString(payload, 'summary', runtimeTask);
    if (payload.usage && typeof payload.usage === 'object') {
      runtimeTask.usage = payload.usage as Record<string, unknown>;
    }
  } else if (type === 'claude_runtime_task_completed') {
    runtimeTask.status = 'completed';
    copyString(payload, 'subject', runtimeTask);
    copyString(payload, 'description', runtimeTask);
    copyString(payload, 'teammate_name', runtimeTask, 'teammateName');
    copyString(payload, 'team_name', runtimeTask, 'teamName');
  } else if (type === 'claude_runtime_task_notification') {
    const status = asTaskStatus(payload.status);
    if (status) runtimeTask.status = status;
    copyString(payload, 'output_file', runtimeTask, 'outputFile');
    copyString(payload, 'summary', runtimeTask);
    if (typeof payload.skip_transcript === 'boolean') {
      runtimeTask.skipTranscript = payload.skip_transcript;
    }
    if (payload.usage && typeof payload.usage === 'object') {
      runtimeTask.usage = payload.usage as Record<string, unknown>;
    }
  }
  next.tasks[taskId] = runtimeTask;
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asSessionState(value: unknown): ClaudeRuntimeView['sessionState'] | undefined {
  return value === 'idle' || value === 'running' || value === 'requires_action'
    ? value
    : undefined;
}

function asTaskStatus(value: unknown): ClaudeRuntimeTaskStatus | undefined {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'stopped' ||
    value === 'killed'
  )
    ? value
    : undefined;
}

function asNotificationSource(
  value: unknown,
): ClaudeRuntimeNotification['source'] | undefined {
  return value === 'hook' || value === 'system' || value === 'tool_use'
    ? value
    : undefined;
}

function asRemoteTriggerSource(
  value: unknown,
): ClaudeRuntimeRemoteTrigger['source'] | undefined {
  return value === 'message_origin' || value === 'tool_use' ? value : undefined;
}

function asScheduleKind(value: unknown): ClaudeRuntimeScheduleKind | undefined {
  return value === 'wakeup' || value === 'cron' ? value : undefined;
}

function asScheduleStatus(value: unknown): ClaudeRuntimeScheduleStatus | undefined {
  return (
    value === 'active' ||
    value === 'dispatching' ||
    value === 'firing' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'failed' ||
    value === 'orphaned'
  )
    ? value
    : undefined;
}

function scheduleFromPayload(
  scheduleId: string,
  payload: Record<string, unknown>,
): ClaudeRuntimeSchedule {
  const schedule: ClaudeRuntimeSchedule = {
    scheduleId,
    kind: asScheduleKind(payload.schedule_kind) ?? 'wakeup',
    status: asScheduleStatus(payload.status) ?? 'active',
  };
  copyString(payload, 'session_id', schedule, 'sessionId');
  copyString(payload, 'prompt', schedule);
  copyString(payload, 'source_tool', schedule, 'sourceTool');
  copyNullableString(payload, 'tool_use_id', schedule, 'toolUseId');
  copyNullableString(payload, 'cron_expression', schedule, 'cronExpression');
  copyNullableString(payload, 'run_once_at', schedule, 'runOnceAt');
  copyString(payload, 'timezone', schedule);
  if (typeof payload.recurring === 'boolean') schedule.recurring = payload.recurring;
  copyNullableString(payload, 'next_run_at', schedule, 'nextRunAt');
  copyNullableString(payload, 'last_fired_at', schedule, 'lastFiredAt');
  if (typeof payload.fired_count === 'number') schedule.firedCount = payload.fired_count;
  copyNullableString(payload, 'last_error', schedule, 'lastError');
  copyString(payload, 'created_at', schedule, 'createdAt');
  copyString(payload, 'updated_at', schedule, 'updatedAt');
  return schedule;
}

function computeNextScheduleRunAt(
  schedules: Record<string, ClaudeRuntimeSchedule>,
): string | null {
  return Object.values(schedules)
    .filter((schedule) => schedule.status === 'active' && schedule.nextRunAt)
    .map((schedule) => schedule.nextRunAt as string)
    .sort()[0] ?? null;
}

function timestampToMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value > 1_000_000_000_000 ? value : value * 1000
    : Date.now();
}

function copyString<T extends object>(
  source: Record<string, unknown>,
  from: string,
  target: T,
  to: string = from,
): void {
  const value = source[from];
  if (typeof value === 'string') {
    (target as Record<string, unknown>)[to] = value;
  }
}

function copyNullableString<T extends object>(
  source: Record<string, unknown>,
  from: string,
  target: T,
  to: string = from,
): void {
  const value = source[from];
  if (typeof value === 'string' || value === null) {
    (target as Record<string, unknown>)[to] = value;
  }
}
