import { useOptionalLayoutContinuity } from '../../navigation/LayoutContinuityContext';
import { useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { PersistentReportEntry } from '../../api/types';
import { EMPTY_REPORT, pendingReportReply, reportSendContext, type ReportReplyDraft } from '../../lib/persistent-report';
import { useSessionStore } from '../../store/sessionStore';
import type { PendingOptimisticEvent } from '../../store/chatStore';

function dismissalId(sessionId: string | undefined, entry: PersistentReportEntry): string {
  return JSON.stringify([sessionId, entry.key, entry.updated_at]);
}

export function usePersistentReport(sessionId: string | undefined, enabled: boolean, api: ApiClient | null,
  snapshot: PersistentReportEntry[] | undefined, pending: PendingOptimisticEvent | undefined,
  projectEntries?: (entries: PersistentReportEntry[]) => PersistentReportEntry[]) {
  const live = useSessionStore(state => enabled && sessionId ? state.persistentReportsBySession[sessionId] : undefined);
  const server = enabled ? live?.entries ?? snapshot ?? EMPTY_REPORT : EMPTY_REPORT;
  const continuity = useOptionalLayoutContinuity();
  const memoryKey = JSON.stringify(['pas', sessionId]);
  const saved = continuity?.getViewState<{ reportKey?: string; reportIndex?: number }>(memoryKey);
  const [view, setView] = useState<{ sessionId: string | undefined; key?: string; index: number;
    dismissals: Map<string, Promise<boolean>> }>({ sessionId, key: saved?.reportKey, index: saved?.reportIndex ?? 0, dismissals: new Map() });
  if (view.sessionId !== sessionId) setView({ sessionId, key: saved?.reportKey, index: saved?.reportIndex ?? 0, dismissals: new Map() });
  const dismissals = view.dismissals;
  const visibleEntries = view.sessionId === sessionId && dismissals.size
    ? server.filter(entry => !dismissals.has(dismissalId(sessionId, entry))) : server;
  const projectedEntries = projectEntries ? projectEntries(visibleEntries) : visibleEntries;
  const found = view.sessionId === sessionId ? projectedEntries.findIndex(entry => entry.key === view.key) : -1;
  const index = found >= 0 ? found : Math.max(0, Math.min(view.sessionId === sessionId ? view.index : 0, projectedEntries.length - 1));
  const key = projectedEntries[index]?.key;
  if ((live !== undefined || snapshot !== undefined) && view.sessionId === sessionId && (view.key !== key || view.index !== index)) setView({ ...view, key, index });
  const reply = pending?.pendingStatus === 'sending' && pending.reportBase === server
    ? pendingReportReply(pending.contextItems) : undefined;
  const entries = reply ? projectedEntries.map(entry => entry.key === reply.key && entry.kind === 'ask' && entry.state === 'open'
    ? { ...entry, state: 'answered' as const, answer: reply.option } : entry) : projectedEntries;

  return {
    entries, index, server,
    select(index: number) {
      const next = Math.max(0, Math.min(entries.length - 1, index));
      continuity?.setViewState(memoryKey, { ...continuity.getViewState<object>(memoryKey), reportKey: entries[next]?.key, reportIndex: next });
      setView(current => ({ ...current, index: next, key: entries[next]?.key }));
    },
    getSendContext(text: string, reply: ReportReplyDraft | null) {
      // The reply baseline stays the server list; the visible reference follows the projection.
      return reportSendContext(server, key, text, reply, entries);
    },
    dismiss(key: string): Promise<boolean> {
      const target = server.find(entry => entry.key === key);
      if (!api || !sessionId || !target) return Promise.resolve(false);
      const id = dismissalId(sessionId, target);
      const existing = dismissals.get(id);
      if (existing) return existing;
      const generation = useSessionStore.getState().scopeGeneration;
      const request = (async () => {
        try {
          await api.dismissPersistentReport(sessionId, key);
          const store = useSessionStore.getState();
          const latest = store.persistentReportsBySession[sessionId]?.entries ?? server;
          // Acknowledge only the requested publication; a revised entry with
          // the same key belongs to the latest server report and stays visible.
          if (store.scopeGeneration === generation && latest.some(entry => dismissalId(sessionId, entry) === id)) {
            store.applyPersistentReport(sessionId, latest.filter(entry => dismissalId(sessionId, entry) !== id));
          }
          dismissals.delete(id);
          setView(current => current.dismissals === dismissals ? { ...current } : current);
          return true;
        } catch {
          dismissals.delete(id);
          setView(current => current.dismissals === dismissals ? { ...current, key, index } : current);
          return false;
        }
      })();
      // Register synchronously, so two presses before a render share one request.
      dismissals.set(id, request);
      setView(current => current.dismissals === dismissals ? { ...current } : current);
      return request;
    },
  };
}
