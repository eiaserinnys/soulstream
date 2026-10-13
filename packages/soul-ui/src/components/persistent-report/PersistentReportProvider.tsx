import { createContext, useCallback, useContext, useState, type PropsWithChildren } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { PersistentReportEntry } from '../../shared/session-types';
import { matchesReportReply, reportMessageContext, selectReportKey, type ReportReplyReceipt, type ReportSendContext } from '../../shared/persistent-report';

type Controller = {
  entries: PersistentReportEntry[];
  visibleKey: string | null;
  view: (key: string) => void;
  bindReply: (entry: PersistentReportEntry, option: string) => void;
  clearReply: () => void;
  draftChanged: (text: string) => void;
  getMessageContext: (text: string) => ReportSendContext;
  answer: (entry: PersistentReportEntry) => string | undefined;
};
const Context = createContext<Controller | null>(null);

/** Owns only report selection and a reply receipt. ChatInput and Virtuoso keep their lifetimes. */
export function PersistentReportProvider({ sessionId, entries, children }: PropsWithChildren<{ sessionId: string; entries: PersistentReportEntry[] }>) {
  const pending = useDashboardStore(state => state.pendingChatSends[sessionId]);
  const [scope, setScope] = useState(() => ({ sessionId, entries, key: (entries[0]?.key ?? null) as string | null, receipt: null as ReportReplyReceipt | null,
    pending: undefined as typeof pending | undefined, optimistic: [] as { source: PersistentReportEntry; id: string; option: string }[] }));
  if (scope.sessionId !== sessionId || scope.entries !== entries || scope.pending !== pending) {
    let optimistic = scope.sessionId === sessionId ? scope.optimistic.filter(reply => entries.includes(reply.source)) : [];
    if (pending?.status === 'failed') optimistic = optimistic.filter(reply => reply.id !== pending.id);
    else if (pending?.status === 'sending' && pending !== scope.pending && pending.persistentReportSource && entries.includes(pending.persistentReportSource)) {
      const option = pending.contextItems?.find(item => item.key === 'persistent_report_reply')?.content.option;
      if (typeof option === 'string') optimistic = [...optimistic.filter(reply => reply.source !== pending.persistentReportSource), { source: pending.persistentReportSource, id: pending.id, option }];
    }
    setScope({ sessionId, entries, key: scope.sessionId === sessionId ? selectReportKey(scope.entries, entries, scope.key) : entries[0]?.key ?? null,
      receipt: scope.sessionId === sessionId ? scope.receipt : null, pending, optimistic });
  }
  const clearReply = useCallback(() => setScope(current => current.receipt ? { ...current, receipt: null } : current), []);
  const controller: Controller = {
    entries,
    visibleKey: scope.key,
    view: key => setScope(current => current.key === key || !current.entries.some(entry => entry.key === key) ? current : { ...current, key }),
    bindReply: (entry, option) => setScope(current => ({ ...current, receipt: { key: entry.key, option, line: `${entry.title}: ${option}` } })),
    clearReply,
    draftChanged: text => {
      if (scope.receipt && !matchesReportReply(text, scope.receipt.line)) clearReply();
    },
    getMessageContext: text => reportMessageContext(entries, scope.key, scope.receipt, text),
    answer: entry => {
      if (entry.state === 'answered') return entry.answer;
      return scope.optimistic.find(reply => reply.source === entry)?.option;
    },
  };
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}

export function usePersistentReport() { return useContext(Context); }
