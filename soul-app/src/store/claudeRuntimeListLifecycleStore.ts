import { create } from 'zustand';
import { subscribeAuthScope } from '../lib/auth-scope';

export type ClaudeRuntimeListKind = 'tasks' | 'schedules';

type InitialRefreshSuppression = Partial<Record<ClaudeRuntimeListKind, true>>;

interface ScheduleChange {
  revision: number;
  deleted: boolean;
}

interface RuntimeListRevision {
  tasks: number;
  schedules: number;
  reset: number;
}

interface ClaudeRuntimeListLifecycleStore {
  initialRefreshSuppressionBySession: Record<string, InitialRefreshSuppression>;
  revisionCounter: number;
  revisionsBySession: Record<string, RuntimeListRevision>;
  scheduleChangesBySession: Record<string, Record<string, ScheduleChange>>;
  markFreshSession(sessionId: string): void;
  acknowledgeInitialRefresh(
    sessionId: string,
    kind: ClaudeRuntimeListKind,
  ): void;
  noteRuntimeEvent(sessionId: string, type: string, data: unknown): void;
  invalidateSession(sessionId: string): void;
}

export const useClaudeRuntimeListLifecycleStore =
  create<ClaudeRuntimeListLifecycleStore>((set) => ({
    initialRefreshSuppressionBySession: {},
    revisionCounter: 0,
    revisionsBySession: {},
    scheduleChangesBySession: {},
    markFreshSession: (sessionId) => set((state) => ({
      initialRefreshSuppressionBySession: {
        ...state.initialRefreshSuppressionBySession,
        [sessionId]: { tasks: true, schedules: true },
      },
    })),
    acknowledgeInitialRefresh: (sessionId, kind) => set((state) => {
      const current = state.initialRefreshSuppressionBySession[sessionId];
      if (!current?.[kind]) return state;
      const nextForSession = { ...current };
      delete nextForSession[kind];
      const next = { ...state.initialRefreshSuppressionBySession };
      if (Object.keys(nextForSession).length === 0) {
        delete next[sessionId];
      } else {
        next[sessionId] = nextForSession;
      }
      return { initialRefreshSuppressionBySession: next };
    }),
    noteRuntimeEvent: (sessionId, type, data) => set((state) => {
      if (!type.startsWith('claude_runtime_') || type === 'claude_runtime_hook_event') {
        return state;
      }
      const revision = state.revisionCounter + 1;
      const current = state.revisionsBySession[sessionId]
        ?? { tasks: 0, schedules: 0, reset: 0 };
      const scheduleEvent = type === 'claude_runtime_schedule_updated'
        || type === 'claude_runtime_schedule_deleted';
      const revisionsBySession = {
        ...state.revisionsBySession,
        [sessionId]: {
          ...current,
          [scheduleEvent ? 'schedules' : 'tasks']: revision,
        },
      };
      if (!scheduleEvent) {
        return { revisionCounter: revision, revisionsBySession };
      }
      const scheduleId = readScheduleId(data);
      if (!scheduleId) {
        return { revisionCounter: revision, revisionsBySession };
      }
      return {
        revisionCounter: revision,
        revisionsBySession,
        scheduleChangesBySession: {
          ...state.scheduleChangesBySession,
          [sessionId]: {
            ...state.scheduleChangesBySession[sessionId],
            [scheduleId]: {
              revision,
              deleted: type === 'claude_runtime_schedule_deleted',
            },
          },
        },
      };
    }),
    invalidateSession: (sessionId) => set((state) => {
      const revision = state.revisionCounter + 1;
      return {
        revisionCounter: revision,
        revisionsBySession: {
          ...state.revisionsBySession,
          [sessionId]: { tasks: revision, schedules: revision, reset: revision },
        },
      };
    }),
  }));

export function markClaudeRuntimeListsFresh(sessionId: string): void {
  useClaudeRuntimeListLifecycleStore.getState().markFreshSession(sessionId);
}

export function noteClaudeRuntimeListEvent(
  sessionId: string,
  type: string,
  data: unknown,
): void {
  useClaudeRuntimeListLifecycleStore.getState().noteRuntimeEvent(
    sessionId,
    type,
    data,
  );
}

export function invalidateClaudeRuntimeLists(sessionId: string): void {
  useClaudeRuntimeListLifecycleStore.getState().invalidateSession(sessionId);
}

subscribeAuthScope(() => {
  useClaudeRuntimeListLifecycleStore.setState({
    initialRefreshSuppressionBySession: {},
    revisionCounter: 0,
    revisionsBySession: {},
    scheduleChangesBySession: {},
  });
});

function readScheduleId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const scheduleId = (data as Record<string, unknown>).schedule_id;
  return typeof scheduleId === 'string' && scheduleId.length > 0
    ? scheduleId
    : null;
}
