import { createContext, useCallback, useContext, useState, type PropsWithChildren } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { PersistentReportEntry } from '../../shared/session-types';
import { matchesReportReply, reportMessageContext, selectReportKey, type ReportReplyReceipt, type ReportSendContext, type ReportSendOperation } from '../../shared/persistent-report';

type Controller = {
  entries: PersistentReportEntry[];
  visibleKey: string | null;
  view: (key: string) => void;
  bindReply: (entry: PersistentReportEntry, option: string) => void;
  clearReply: () => void;
  draftChanged: (text: string) => void;
  getMessageContext: (text: string) => ReportSendContext;
  canCancel: (entry: PersistentReportEntry) => boolean;
  cancelRequested: (entry: PersistentReportEntry) => boolean;
  answer: (entry: PersistentReportEntry) => string | undefined;
};
type OperationReceipt = { operation: ReportSendOperation; id: string; status: 'sending' | 'failed' | 'acknowledged' };
const samePublication = (entry: PersistentReportEntry, operation: ReportSendOperation) => entry.key === operation.key && entry.updated_at === operation.updatedAt;
const Context = createContext<Controller | null>(null);

/** Owns only report selection and a reply receipt. ChatInput and Virtuoso keep their lifetimes. */
export function PersistentReportProvider({ sessionId, entries, children }: PropsWithChildren<{ sessionId: string; entries: PersistentReportEntry[] }>) {
  const pending = useDashboardStore(state => state.pendingChatSends[sessionId]);
  const [scope, setScope] = useState(() => ({ sessionId, entries, key: (entries[0]?.key ?? null) as string | null, receipt: null as ReportReplyReceipt | null,
    pending: undefined as typeof pending | undefined, operations: [] as OperationReceipt[], optimistic: [] as { source: PersistentReportEntry; id: string; option: string }[] }));
  if (scope.sessionId !== sessionId || scope.entries !== entries || scope.pending !== pending) {
    let optimistic = scope.sessionId === sessionId ? scope.optimistic.filter(reply => entries.includes(reply.source)) : [];
    if (pending?.status === 'failed') optimistic = optimistic.filter(reply => reply.id !== pending.id);
    else if (pending?.status === 'sending' && pending !== scope.pending && pending.persistentReportSource && entries.includes(pending.persistentReportSource)) {
      const option = pending.contextItems?.find(item => item.key === 'persistent_report_reply')?.content.option;
      if (typeof option === 'string') optimistic = [...optimistic.filter(reply => reply.source !== pending.persistentReportSource), { source: pending.persistentReportSource, id: pending.id, option }];
    }
    // Operation receipts follow the pending slot, including the chat's ordinary retry.
    // Keep acknowledged publications after the echoed chat event clears the slot.
    let operations = scope.sessionId === sessionId ? scope.operations.filter(receipt => entries.some(entry => samePublication(entry, receipt.operation)) && (receipt.status !== 'failed' || receipt.id === pending?.id)) : [];
    const remember = (operation: ReportSendOperation, id: string, status: OperationReceipt['status']) => {
      if (!entries.some(entry => samePublication(entry, operation))) return;
      operations = [...operations.filter(receipt => receipt.operation.kind !== operation.kind || receipt.operation.key !== operation.key), { operation, id, status }];
    };
    if (scope.sessionId === sessionId && scope.pending?.status === 'sending' && scope.pending.persistentReportOperation && !pending) remember(scope.pending.persistentReportOperation, scope.pending.id, 'acknowledged');
    if (pending?.persistentReportOperation) remember(pending.persistentReportOperation, pending.id, pending.status === 'failed' ? 'failed' : pending.persistentReportOperation.acknowledged ? 'acknowledged' : 'sending');
    setScope({ sessionId, entries, operations, key: scope.sessionId === sessionId ? selectReportKey(scope.entries, entries, scope.key) : entries[0]?.key ?? null,
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
    canCancel: entry => entry.state === 'answered' || scope.operations.some(receipt => samePublication(entry, receipt.operation) && receipt.operation.kind === 'reply' && receipt.status === 'acknowledged'),
    cancelRequested: entry => scope.operations.some(receipt => samePublication(entry, receipt.operation) && receipt.operation.kind === 'cancel' && receipt.status !== 'failed'),
    answer: entry => {
      if (entry.state === 'answered') return entry.answer;
      return scope.optimistic.find(reply => reply.source === entry)?.option;
    },
  };
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}

export function usePersistentReport() { return useContext(Context); }
