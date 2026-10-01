import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import type { ApiClient } from '../../api/client';
import type {
  ClaudeRuntimeMode,
  ClaudeRuntimeNotification,
  ClaudeRuntimeRemoteTrigger,
  ClaudeRuntimeSchedule,
  ClaudeRuntimeSchedulesResponse,
  ClaudeRuntimeTask,
  ClaudeRuntimeTasksResponse,
  ClaudeRuntimeTranscriptMirror,
} from '../../api/types';
import {
  captureAuthScope,
  isAuthScopeCurrent,
  useAuthScopeGeneration,
} from '../../lib/auth-scope';
import { useChatStore } from '../../store/chatStore';
import {
  useClaudeRuntimeListLifecycleStore,
  type ClaudeRuntimeListKind,
} from '../../store/claudeRuntimeListLifecycleStore';

interface RefreshState {
  loading: boolean;
  recoveryNeeded: boolean;
  refresh(): Promise<void>;
}

interface TasksRefreshOptions {
  automatic?: boolean;
  errorTitle?: string;
}

interface RefreshConfig<Response, Snapshot> {
  sessionId: string;
  api: ApiClient | null;
  kind: ClaudeRuntimeListKind;
  automatic: boolean;
  errorTitle: string;
  request(api: ApiClient, sessionId: string): Promise<Response>;
  apply(sessionId: string, response: Response): void;
  capture(sessionId: string): Snapshot;
  merge(response: Response, baseline: Snapshot, current: Snapshot): Response | null;
}

interface TasksSnapshot {
  revision: number;
  resetRevision: number;
  sessionState: ClaudeRuntimeTasksResponse['sessionState'];
  runtimeSessionId: string | null;
  updatedAt: number | null;
  tasks: Record<string, ClaudeRuntimeTask>;
  notifications: Record<string, ClaudeRuntimeNotification>;
  remoteTriggers: Record<string, ClaudeRuntimeRemoteTrigger>;
  transcriptMirror: ClaudeRuntimeTranscriptMirror | null;
  planMode: ClaudeRuntimeMode | null;
  worktreeMode: ClaudeRuntimeMode | null;
}

interface SchedulesSnapshot {
  revision: number;
  resetRevision: number;
  schedules: Record<string, ClaudeRuntimeSchedule>;
  changes: Record<string, { revision: number; deleted: boolean }>;
}

export function useClaudeRuntimeTasksRefresh(
  sessionId: string,
  api: ApiClient | null,
  options: TasksRefreshOptions = {},
): RefreshState {
  return useClaudeRuntimeListRefresh({
    sessionId,
    api,
    kind: 'tasks',
    automatic: options.automatic ?? true,
    errorTitle: options.errorTitle ?? '조회 실패',
    request: requestTasks,
    apply: applyTasks,
    capture: captureTasks,
    merge: mergeTasks,
  });
}

export function useClaudeRuntimeSchedulesRefresh(
  sessionId: string,
  api: ApiClient | null,
): RefreshState {
  return useClaudeRuntimeListRefresh({
    sessionId,
    api,
    kind: 'schedules',
    automatic: true,
    errorTitle: '예약 조회 실패',
    request: requestSchedules,
    apply: applySchedules,
    capture: captureSchedules,
    merge: mergeSchedules,
  });
}

function useClaudeRuntimeListRefresh<Response, Snapshot>({
  sessionId,
  api,
  kind,
  automatic,
  errorTitle,
  request,
  apply,
  capture,
  merge,
}: RefreshConfig<Response, Snapshot>): RefreshState {
  const [loading, setLoading] = useState(false);
  const [recoveryNeeded, setRecoveryNeeded] = useState(false);
  const requestToken = useRef(0);
  const scopeGeneration = useAuthScopeGeneration();
  const suppressed = useClaudeRuntimeListLifecycleStore((state) => (
    state.initialRefreshSuppressionBySession[sessionId]?.[kind] === true
  ));
  const acknowledgeInitialRefresh = useClaudeRuntimeListLifecycleStore(
    (state) => state.acknowledgeInitialRefresh,
  );
  const initialDecision = useRef<{
    sessionId: string;
    api: ApiClient | null;
    scopeGeneration: string;
    suppressed: boolean;
  } | null>(null);
  if (
    !initialDecision.current
    || initialDecision.current.sessionId !== sessionId
    || initialDecision.current.api !== api
    || initialDecision.current.scopeGeneration !== scopeGeneration
  ) {
    initialDecision.current = { sessionId, api, scopeGeneration, suppressed };
  }

  const runRefresh = useCallback(async (reportFailure: boolean) => {
    if (!api) return;
    const token = ++requestToken.current;
    const authScope = captureAuthScope();
    const baseline = capture(sessionId);
    setLoading(true);
    try {
      const response = await request(api, sessionId);
      if (requestToken.current !== token || !isAuthScopeCurrent(authScope)) return;
      const reconciled = merge(response, baseline, capture(sessionId));
      if (!reconciled) {
        setRecoveryNeeded(true);
        return;
      }
      apply(sessionId, reconciled);
      setRecoveryNeeded(false);
    } catch (error: unknown) {
      if (requestToken.current !== token || !isAuthScopeCurrent(authScope)) return;
      if (reportFailure) {
        Alert.alert(errorTitle, errorMessage(error));
      } else {
        setRecoveryNeeded(true);
      }
    } finally {
      if (requestToken.current === token) setLoading(false);
    }
  }, [api, apply, capture, errorTitle, merge, request, sessionId]);

  useEffect(() => {
    requestToken.current += 1;
    setLoading(false);
    setRecoveryNeeded(false);
    if (automatic) {
      const skip = initialDecision.current?.suppressed === true;
      acknowledgeInitialRefresh(sessionId, kind);
      if (!skip) void runRefresh(false);
    }
    return () => {
      requestToken.current += 1;
    };
  }, [
    acknowledgeInitialRefresh,
    api,
    automatic,
    kind,
    runRefresh,
    scopeGeneration,
    sessionId,
  ]);

  const refresh = useCallback(
    () => runRefresh(true),
    [runRefresh],
  );
  return { loading, recoveryNeeded, refresh };
}

function requestTasks(
  api: ApiClient,
  sessionId: string,
): Promise<ClaudeRuntimeTasksResponse> {
  return api.listClaudeBackgroundTasks(sessionId);
}

function applyTasks(sessionId: string, response: ClaudeRuntimeTasksResponse): void {
  useChatStore.getState().setClaudeRuntimeTasks(sessionId, response);
}

function requestSchedules(
  api: ApiClient,
  sessionId: string,
): Promise<ClaudeRuntimeSchedulesResponse> {
  return api.listClaudeSchedules(sessionId);
}

function applySchedules(
  sessionId: string,
  response: ClaudeRuntimeSchedulesResponse,
): void {
  useChatStore.getState().setClaudeRuntimeSchedules(sessionId, response);
}

function captureTasks(sessionId: string): TasksSnapshot {
  const runtime = useChatStore.getState().claudeRuntimeBySession[sessionId];
  const revision = runtimeListRevision(sessionId);
  return {
    revision: revision.tasks,
    resetRevision: revision.reset,
    sessionState: runtime?.sessionState ?? null,
    runtimeSessionId: runtime?.runtimeSessionId ?? null,
    updatedAt: runtime?.updatedAt ?? null,
    tasks: runtime?.tasks ?? {},
    notifications: runtime?.notifications ?? {},
    remoteTriggers: runtime?.remoteTriggers ?? {},
    transcriptMirror: runtime?.transcriptMirror ?? null,
    planMode: runtime?.planMode ?? null,
    worktreeMode: runtime?.worktreeMode ?? null,
  };
}

function mergeTasks(
  response: ClaudeRuntimeTasksResponse,
  baseline: TasksSnapshot,
  current: TasksSnapshot,
): ClaudeRuntimeTasksResponse | null {
  if (current.resetRevision > baseline.revision) return null;
  return {
    ...response,
    sessionState: preferChanged(response.sessionState, baseline.sessionState, current.sessionState),
    runtimeSessionId: preferChanged(
      response.runtimeSessionId,
      baseline.runtimeSessionId,
      current.runtimeSessionId,
    ),
    updatedAt: current.revision > baseline.revision
      ? current.updatedAt ?? response.updatedAt
      : response.updatedAt,
    tasks: mergeChangedRecords(response.tasks, baseline.tasks, current.tasks, 'taskId'),
    notifications: response.notifications === undefined
      ? undefined
      : mergeChangedRecords(
          response.notifications,
          baseline.notifications,
          current.notifications,
          'notificationId',
        ),
    remoteTriggers: response.remoteTriggers === undefined
      ? undefined
      : mergeChangedRecords(
          response.remoteTriggers,
          baseline.remoteTriggers,
          current.remoteTriggers,
          'triggerId',
        ),
    transcriptMirror: preferChanged(
      response.transcriptMirror,
      baseline.transcriptMirror,
      current.transcriptMirror,
    ),
    planMode: preferChanged(response.planMode, baseline.planMode, current.planMode),
    worktreeMode: preferChanged(
      response.worktreeMode,
      baseline.worktreeMode,
      current.worktreeMode,
    ),
  };
}

function captureSchedules(sessionId: string): SchedulesSnapshot {
  const runtime = useChatStore.getState().claudeRuntimeBySession[sessionId];
  const lifecycle = useClaudeRuntimeListLifecycleStore.getState();
  const revision = runtimeListRevision(sessionId);
  return {
    revision: revision.schedules,
    resetRevision: revision.reset,
    schedules: runtime?.schedules ?? {},
    changes: lifecycle.scheduleChangesBySession[sessionId] ?? {},
  };
}

function mergeSchedules(
  response: ClaudeRuntimeSchedulesResponse,
  baseline: SchedulesSnapshot,
  current: SchedulesSnapshot,
): ClaudeRuntimeSchedulesResponse | null {
  if (current.resetRevision > baseline.revision) return null;
  const schedules = Object.fromEntries(
    response.schedules.map((schedule) => [schedule.scheduleId, schedule]),
  );
  for (const [scheduleId, change] of Object.entries(current.changes)) {
    if (change.revision <= baseline.revision) continue;
    const live = current.schedules[scheduleId];
    if (change.deleted || !live) {
      delete schedules[scheduleId];
    } else {
      schedules[scheduleId] = live;
    }
  }
  const merged = Object.values(schedules);
  return {
    ...response,
    schedules: merged,
    nextRunAt: nextScheduleRunAt(merged),
  };
}

function runtimeListRevision(sessionId: string) {
  return useClaudeRuntimeListLifecycleStore.getState().revisionsBySession[sessionId]
    ?? { tasks: 0, schedules: 0, reset: 0 };
}

function mergeChangedRecords<Item>(
  snapshot: readonly Item[],
  baseline: Record<string, Item>,
  current: Record<string, Item>,
  key: keyof Item,
): Item[] {
  const merged = Object.fromEntries(
    snapshot.map((item) => [String(item[key]), item]),
  ) as Record<string, Item>;
  for (const id of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    if (baseline[id] === current[id]) continue;
    if (current[id]) {
      merged[id] = current[id];
    } else {
      delete merged[id];
    }
  }
  return Object.values(merged);
}

function preferChanged<T>(snapshot: T, baseline: T, current: T): T {
  return current !== baseline ? current : snapshot;
}

function nextScheduleRunAt(schedules: readonly ClaudeRuntimeSchedule[]): string | null {
  const values = schedules
    .filter((schedule) => schedule.status === 'active' && schedule.nextRunAt)
    .map((schedule) => schedule.nextRunAt as string)
    .sort();
  return values[0] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '알 수 없는 오류';
}
