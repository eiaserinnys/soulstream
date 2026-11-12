import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from 'react';
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
  /** 카드 #1197 화면 계약 3절 2번: 이 화면에서 보낸 선택 답을 판 교체 뒤에도 같은 자리에 붙든다. */
  hold: (entry: PersistentReportEntry, option: string) => void;
};
type OperationReceipt = { operation: ReportSendOperation; id: string; status: 'sending' | 'failed' | 'acknowledged' };
type HeldPanel = { entry: PersistentReportEntry; answer: string; index: number; siblings: string[] };
type ReplyScope = HeldPanel & { id: string };
const samePublication = (entry: PersistentReportEntry, operation: ReportSendOperation) => entry.key === operation.key && entry.updated_at === operation.updatedAt;
const cardOf = (entry: PersistentReportEntry) => (entry as PersistentReportEntry & { card_id?: string }).card_id ?? null;
const sameCardSiblings = (entries: PersistentReportEntry[], entry: PersistentReportEntry) => {
  const card = cardOf(entry);
  if (!card) return [];
  return entries.filter(item => item.key !== entry.key && cardOf(item) === card).map(item => item.key);
};
const mergeHeld = (entries: PersistentReportEntry[], held: HeldPanel | null): PersistentReportEntry[] => {
  if (!held) return entries;
  const index = entries.findIndex(entry => entry.key === held.entry.key);
  if (index >= 0) {
    const merged = entries.slice();
    merged[index] = { ...entries[index], state: 'answered', answer: held.answer };
    return merged;
  }
  const at = Math.min(Math.max(0, held.index), entries.length);
  return [...entries.slice(0, at), { ...held.entry, state: 'answered', answer: held.answer }, ...entries.slice(at)];
};
const Context = createContext<Controller | null>(null);

/** Owns only report selection, a reply receipt and the answered question sheet this screen sent. */
export function PersistentReportProvider({ sessionId, entries, children }: PropsWithChildren<{ sessionId: string; entries: PersistentReportEntry[] }>) {
  const pending = useDashboardStore(state => state.pendingChatSends[sessionId]);
  const [scope, setScope] = useState(() => ({ sessionId, entries, key: (entries[0]?.key ?? null) as string | null, receipt: null as ReportReplyReceipt | null,
    pending: undefined as typeof pending | undefined, operations: [] as OperationReceipt[], optimistic: [] as { source: PersistentReportEntry; id: string; option: string }[],
    held: null as HeldPanel | null, replyScope: null as ReplyScope | null }));
  if (scope.sessionId !== sessionId || scope.entries !== entries || scope.pending !== pending) {
    const sameSession = scope.sessionId === sessionId;
    let optimistic = sameSession ? scope.optimistic.filter(reply => entries.includes(reply.source)) : [];
    let held = sameSession ? scope.held : null;
    let replyScope = sameSession ? scope.replyScope : null;
    if (pending?.status === 'failed') {
      optimistic = optimistic.filter(reply => reply.id !== pending.id);
      if (replyScope?.id === pending.id) replyScope = null;
    } else if (pending?.status === 'sending' && pending !== scope.pending && pending.persistentReportSource && entries.includes(pending.persistentReportSource)) {
      const option = pending.contextItems?.find(item => item.key === 'persistent_report_reply')?.content.option;
      if (typeof option === 'string') {
        optimistic = [...optimistic.filter(reply => reply.source !== pending.persistentReportSource), { source: pending.persistentReportSource, id: pending.id, option }];
        if (pending.persistentReportOperation?.kind === 'reply') {
          const source = pending.persistentReportSource;
          replyScope = { id: pending.id, entry: source, answer: option, index: Math.max(0, entries.findIndex(entry => entry.key === source.key)), siblings: sameCardSiblings(entries, source) };
        }
      }
    }
    // A reply this screen sent is acknowledged by the panel answer ACK. Keep its answer on the
    // same key and place while the server board drops the answered question, until the board
    // publishes another sheet for the same card or the reader moves to another sheet.
    const previous = scope.pending;
    const wasReply = previous?.status === 'sending' && previous.persistentReportOperation?.kind === 'reply';
    const acknowledged = Boolean(wasReply && (pending?.id !== previous!.id || pending?.persistentReportOperation?.acknowledged === true));
    if (acknowledged && replyScope?.id === previous!.id) {
      held = { entry: replyScope.entry, answer: replyScope.answer, index: replyScope.index, siblings: replyScope.siblings };
      replyScope = null;
    }
    if (held) {
      const card = cardOf(held.entry);
      if (!sameSession || (card !== null && entries.some(entry => entry.key !== held!.entry.key && cardOf(entry) === card && !held!.siblings.includes(entry.key)))) held = null;
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
    setScope({ sessionId, entries, operations, held, replyScope, key: sameSession ? selectReportKey(mergeHeld(scope.entries, scope.held), mergeHeld(entries, held), scope.key) : mergeHeld(entries, held)[0]?.key ?? null,
      receipt: sameSession ? scope.receipt : null, pending, optimistic });
  }
  const mergedEntries = useMemo(() => mergeHeld(scope.entries, scope.held), [scope.entries, scope.held]);
  const clearReply = useCallback(() => setScope(current => current.receipt ? { ...current, receipt: null } : current), []);
  const controller: Controller = {
    entries: mergedEntries,
    visibleKey: scope.key,
    view: key => setScope(current => {
      const merged = mergeHeld(current.entries, current.held);
      if (current.key === key || !merged.some(entry => entry.key === key)) return current;
      return { ...current, key, held: current.held && current.held.entry.key !== key ? null : current.held };
    }),
    bindReply: (entry, option) => setScope(current => ({ ...current, receipt: { key: entry.key, option, line: `${entry.title}: ${option}` } })),
    clearReply,
    draftChanged: text => {
      if (scope.receipt && !matchesReportReply(text, scope.receipt.line)) clearReply();
    },
    getMessageContext: text => reportMessageContext(entries, scope.key, scope.receipt, text),
    canCancel: entry => entry.state === 'answered',
    cancelRequested: entry => scope.operations.some(receipt => samePublication(entry, receipt.operation) && receipt.operation.kind === 'cancel' && receipt.status !== 'failed'),
    answer: entry => {
      if (entry.state === 'answered') return entry.answer;
      return scope.optimistic.find(reply => reply.source === entry)?.option;
    },
    hold: (entry, option) => setScope(current => {
      const merged = mergeHeld(current.entries, current.held);
      const index = merged.findIndex(item => item.key === entry.key);
      if (index < 0) return current;
      return { ...current, held: { entry, answer: option, index, siblings: sameCardSiblings(merged, entry) } };
    }),
  };
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}

export function usePersistentReport() { return useContext(Context); }
