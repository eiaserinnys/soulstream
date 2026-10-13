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
    dismissed?: { key: string; base: PersistentReportEntry[] } }>({ sessionId, index: 0 });
  if (view.sessionId !== sessionId) setView({ sessionId, index: 0 });
  const dismissed = view.sessionId === sessionId && view.dismissed?.base === server ? view.dismissed.key : undefined;
  const visibleEntries = dismissed ? server.filter(entry => entry.key !== dismissed) : server;
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
    async dismiss(key: string) {
      if (!api || !sessionId) return false;
      const store = useSessionStore.getState();
      const baseline = { snapshot: store.persistentReportsBySession[sessionId], generation: store.scopeGeneration };
      setView(current => ({ ...current, dismissed: { key, base: server } }));
      try {
        const result = await api.dismissPersistentReport(sessionId, key);
        useSessionStore.getState().applyPersistentReport(sessionId, result.persistent_report, baseline);
        return true;
      } catch {
        setView(current => current.dismissed?.base === server && current.dismissed.key === key
          ? { ...current, dismissed: undefined, key, index } : current);
        return false;
      }
    },
  };
}
