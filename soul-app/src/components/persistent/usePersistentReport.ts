import { useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { PersistentReportEntry } from '../../api/types';
import { EMPTY_REPORT, pendingReportReply, reportSendContext, type ReportReplyDraft } from '../../lib/persistent-report';
import { useSessionStore } from '../../store/sessionStore';
import type { PendingOptimisticEvent } from '../../store/chatStore';

export function usePersistentReport(sessionId: string | undefined, enabled: boolean, api: ApiClient | null,
  snapshot: PersistentReportEntry[] | undefined, pending: PendingOptimisticEvent | undefined) {
  const live = useSessionStore(state => enabled && sessionId ? state.persistentReportsBySession[sessionId] : undefined);
  const server = enabled ? live?.entries ?? snapshot ?? EMPTY_REPORT : EMPTY_REPORT;
  const [view, setView] = useState<{ sessionId: string | undefined; key?: string; index: number;
    dismissals: Map<string, Promise<boolean>> }>({ sessionId, index: 0, dismissals: new Map() });
  if (view.sessionId !== sessionId) setView({ sessionId, index: 0, dismissals: new Map() });
  const dismissals = view.dismissals;
  const visibleEntries = view.sessionId === sessionId && dismissals.size
    ? server.filter(entry => !dismissals.has(entry.key)) : server;
  const found = view.sessionId === sessionId ? visibleEntries.findIndex(entry => entry.key === view.key) : -1;
  const index = found >= 0 ? found : Math.max(0, Math.min(view.sessionId === sessionId ? view.index : 0, visibleEntries.length - 1));
  const key = visibleEntries[index]?.key;
  if (view.sessionId === sessionId && (view.key !== key || view.index !== index)) setView({ ...view, key, index });
  const reply = pending?.pendingStatus === 'sending' && pending.reportBase === server
    ? pendingReportReply(pending.contextItems) : undefined;
  const entries = reply ? visibleEntries.map(entry => entry.key === reply.key && entry.kind === 'ask' && entry.state === 'open'
    ? { ...entry, state: 'answered' as const, answer: reply.option } : entry) : visibleEntries;

  return {
    entries, index,
    select(index: number) {
      const next = Math.max(0, Math.min(entries.length - 1, index));
      setView(current => ({ ...current, index: next, key: entries[next]?.key }));
    },
    getSendContext(text: string, reply: ReportReplyDraft | null) {
      return reportSendContext(server, key, text, reply);
    },
    dismiss(key: string): Promise<boolean> {
      const existing = dismissals.get(key);
      if (existing) return existing;
      if (!api || !sessionId) return Promise.resolve(false);
      const generation = useSessionStore.getState().scopeGeneration;
      const request = (async () => {
        try {
          await api.dismissPersistentReport(sessionId, key);
          const store = useSessionStore.getState();
          const latest = store.persistentReportsBySession[sessionId]?.entries ?? server;
          // HTTP replies can arrive out of order: acknowledge only this key,
          // keeping other entries from the latest server projection intact.
          if (store.scopeGeneration === generation && latest.some(entry => entry.key === key)) {
            store.applyPersistentReport(sessionId, latest.filter(entry => entry.key !== key));
          }
          dismissals.delete(key);
          setView(current => current.dismissals === dismissals ? { ...current } : current);
          return true;
        } catch {
          dismissals.delete(key);
          setView(current => current.dismissals === dismissals ? { ...current, key, index } : current);
          return false;
        }
      })();
      // Register synchronously, so two presses before a render share one request.
      dismissals.set(key, request);
      setView(current => current.dismissals === dismissals ? { ...current } : current);
      return request;
    },
  };
}
