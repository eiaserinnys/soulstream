import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { listClaudeBackgroundTasks } from "../lib/claude-runtime-actions";
import { useDashboardStore } from "../stores/dashboard-store";
import type {
  ClaudeRuntimeNotificationView,
  ClaudeRuntimeRemoteTriggerView,
  ClaudeRuntimeTranscriptMirrorView,
  ClaudeRuntimeView,
} from "../stores/claude-runtime-state";

export interface ClaudeRuntimeSignalsView {
  notifications: ClaudeRuntimeNotificationView[];
  remoteTriggers: ClaudeRuntimeRemoteTriggerView[];
  mirror: ClaudeRuntimeTranscriptMirrorView | null;
  hasSignals: boolean;
  visibleCount: number;
  hasError: boolean;
  errorCount: number;
}

interface ClaudeRuntimeSignalsFallback {
  notifications: ClaudeRuntimeNotificationView[];
  remoteTriggers: ClaudeRuntimeRemoteTriggerView[];
  mirror: ClaudeRuntimeTranscriptMirrorView | null;
}

interface ClaudeRuntimeSignalsFallbackEntry extends ClaudeRuntimeSignalsFallback {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  revision: number;
}

export interface ResolveClaudeRuntimeSignalsOptions {
  notificationLimit?: number;
  remoteTriggerLimit?: number;
  fallbackNotifications?: ClaudeRuntimeNotificationView[];
  fallbackRemoteTriggers?: ClaudeRuntimeRemoteTriggerView[];
  fallbackMirror?: ClaudeRuntimeTranscriptMirrorView | null;
}

const EMPTY_FALLBACK_ENTRY: ClaudeRuntimeSignalsFallbackEntry = {
  notifications: [],
  remoteTriggers: [],
  mirror: null,
  loaded: false,
  loading: false,
  error: null,
  revision: 0,
};
const fallbackBySession = new Map<string, ClaudeRuntimeSignalsFallbackEntry>();
const fallbackListeners = new Set<() => void>();

export function resolveClaudeRuntimeSignals(
  runtime: ClaudeRuntimeView | null,
  {
    notificationLimit = 5,
    remoteTriggerLimit = 5,
    fallbackNotifications = [],
    fallbackRemoteTriggers = [],
    fallbackMirror = null,
  }: ResolveClaudeRuntimeSignalsOptions = {},
): ClaudeRuntimeSignalsView {
  const liveNotifications = Object.values(runtime?.notifications ?? {});
  const liveRemoteTriggers = Object.values(runtime?.remoteTriggers ?? {});
  const notifications = [...(liveNotifications.length > 0 ? liveNotifications : fallbackNotifications)]
    .sort(compareUpdatedAt)
    .slice(0, notificationLimit);
  const remoteTriggers = [...(liveRemoteTriggers.length > 0 ? liveRemoteTriggers : fallbackRemoteTriggers)]
    .sort(compareUpdatedAt)
    .slice(0, remoteTriggerLimit);
  const mirror = runtime?.transcriptMirror ?? fallbackMirror;
  const hasSignals = notifications.length > 0 || remoteTriggers.length > 0 || Boolean(mirror);
  const errorCount = mirror?.errorCount ?? 0;

  return {
    notifications,
    remoteTriggers,
    mirror,
    hasSignals,
    visibleCount: notifications.length + remoteTriggers.length + errorCount,
    hasError: errorCount > 0,
    errorCount,
  };
}

export function useClaudeRuntimeSignals(sessionId: string) {
  const runtime = useDashboardStore((s) => s.claudeRuntime);
  const fallback = useSyncExternalStore(
    subscribeFallback,
    () => getFallbackEntry(sessionId),
    () => getFallbackEntry(sessionId),
  );
  const refresh = useCallback(async () => {
    const current = getFallbackEntry(sessionId);
    if (current.loading) return;
    setFallbackEntry(sessionId, { ...current, loading: true, error: null });
    try {
      const response = await listClaudeBackgroundTasks(sessionId);
      setFallbackEntry(sessionId, {
        notifications: response.notifications ?? [],
        remoteTriggers: response.remoteTriggers ?? [],
        mirror: response.transcriptMirror ?? null,
        loaded: true,
        loading: false,
        error: null,
        revision: current.revision + 1,
      });
    } catch (err) {
      setFallbackEntry(sessionId, {
        ...getFallbackEntry(sessionId),
        loaded: true,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [sessionId]);

  useEffect(() => {
    const current = getFallbackEntry(sessionId);
    if (!current.loaded && !current.loading) void refresh();
  }, [refresh, sessionId]);

  const signals = useMemo(
    () => resolveClaudeRuntimeSignals(runtime, {
      fallbackNotifications: fallback.notifications,
      fallbackRemoteTriggers: fallback.remoteTriggers,
      fallbackMirror: fallback.mirror,
    }),
    [fallback, runtime],
  );

  return { signals, loading: fallback.loading, error: fallback.error, refresh };
}

export function resolveClaudeRuntimeSignalsForSessionForTest(
  sessionId: string,
  runtime: ClaudeRuntimeView | null,
): ClaudeRuntimeSignalsView {
  const fallback = getFallbackEntry(sessionId);
  return resolveClaudeRuntimeSignals(runtime, {
    fallbackNotifications: fallback.notifications,
    fallbackRemoteTriggers: fallback.remoteTriggers,
    fallbackMirror: fallback.mirror,
  });
}

export function setClaudeRuntimeSignalsFallbackForTest(
  sessionId: string,
  fallback: ClaudeRuntimeSignalsFallback,
): void {
  setFallbackEntry(sessionId, {
    ...fallback,
    loaded: true,
    loading: false,
    error: null,
    revision: 1,
  });
}

export function resetClaudeRuntimeSignalsFallbackForTest(): void {
  fallbackBySession.clear();
  emitFallback();
}

function compareUpdatedAt<T extends { updatedAt: number }>(left: T, right: T): number {
  return right.updatedAt - left.updatedAt;
}

function subscribeFallback(listener: () => void): () => void {
  fallbackListeners.add(listener);
  return () => {
    fallbackListeners.delete(listener);
  };
}

function getFallbackEntry(sessionId: string): ClaudeRuntimeSignalsFallbackEntry {
  const existing = fallbackBySession.get(sessionId);
  if (existing) return existing;
  const next = { ...EMPTY_FALLBACK_ENTRY };
  fallbackBySession.set(sessionId, next);
  return next;
}

function setFallbackEntry(sessionId: string, entry: ClaudeRuntimeSignalsFallbackEntry): void {
  fallbackBySession.set(sessionId, entry);
  emitFallback();
}

function emitFallback(): void {
  for (const listener of fallbackListeners) listener();
}
