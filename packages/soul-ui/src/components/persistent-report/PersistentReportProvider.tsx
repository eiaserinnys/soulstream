import { createContext, useCallback, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { PersistentReportEntry } from '../../shared/session-types';
import { matchesReportReply, reportMessageContext, selectReportKey, type ReportContextItem, type ReportReplyReceipt, type ReportSendContext, type ReportSendOperation } from '../../shared/persistent-report';

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
  /** 잠정 붙들기를 「답 받음」으로 확정한다. */
  confirm: (key: string) => void;
  /** 보내지 못한 잠정 붙들기를 놓고 판 재계산대로 둔다. */
  release: (key: string) => void;
  /** 확정한 붙들기의 장 key. 잠정 붙들기이거나 붙든 장이 없으면 null. */
  answeredHoldKey: string | null;
  /** 펼치지 않은 채 기한이 지난 확정 붙들기를 놓는다. 잠정 붙들기는 건드리지 않는다. */
  expire: (key: string) => void;
};
type OperationReceipt = { operation: ReportSendOperation; id: string; status: 'sending' | 'failed' | 'acknowledged' };
type HeldPanel = { entry: PersistentReportEntry; answer: string; index: number; siblings: string[]; provisional: boolean };
const replyOption = (pending: { contextItems?: ReportContextItem[] }) => {
  const option = pending.contextItems?.find(item => item.key === 'persistent_report_reply')?.content.option;
  return typeof option === 'string' ? option : undefined;
};
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
    held: null as HeldPanel | null }));
  if (scope.sessionId !== sessionId || scope.entries !== entries || scope.pending !== pending) {
    const sameSession = scope.sessionId === sessionId;
    let optimistic = sameSession ? scope.optimistic.filter(reply => entries.includes(reply.source)) : [];
    let held = sameSession ? scope.held : null;
    if (pending?.status === 'failed') {
      optimistic = optimistic.filter(reply => reply.id !== pending.id);
      // 보내지 못한 잠정 붙들기는 놓고 판 재계산대로 둔다.
      if (held?.provisional && pending.persistentReportSource?.key === held.entry.key && replyOption(pending) === held.answer) held = null;
    } else if (pending?.status === 'sending' && pending !== scope.pending && pending.persistentReportSource && entries.includes(pending.persistentReportSource)) {
      const option = replyOption(pending);
      if (typeof option === 'string') optimistic = [...optimistic.filter(reply => reply.source !== pending.persistentReportSource), { source: pending.persistentReportSource, id: pending.id, option }];
    }
    // A provisional hold is confirmed as 「답 받음」 by the panel answer ACK of the same card
    // question reply, keeping its answer on the same key and place while the server board
    // drops the answered question, until the board publishes another sheet for the same card
    // or the reader moves to another sheet.
    const previous = scope.pending;
    const acknowledged = Boolean(previous?.status === 'sending' && previous.persistentReportOperation?.kind === 'reply'
      && (pending?.id !== previous.id || pending?.persistentReportOperation?.acknowledged === true));
    if (acknowledged && held?.provisional && previous!.persistentReportOperation!.key === held.entry.key && replyOption(previous!) === held.answer) {
      held = { ...held, provisional: false };
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
    setScope({ sessionId, entries, operations, held, key: sameSession ? selectReportKey(mergeHeld(scope.entries, scope.held), mergeHeld(entries, held), scope.key) : mergeHeld(entries, held)[0]?.key ?? null,
      receipt: sameSession ? scope.receipt : null, pending, optimistic });
  }
  const mergedEntries = useMemo(() => mergeHeld(scope.entries, scope.held), [scope.entries, scope.held]);
  const clearReply = useCallback(() => setScope(current => current.receipt ? { ...current, receipt: null } : current), []);
  // 놓은 뒤에는 앱처럼 같은 자리의 옆 장을 본다(판 첫 장으로 튀지 않게).
  const expire = useCallback((key: string) => setScope(current => current.held && !current.held.provisional && current.held.entry.key === key
    ? { ...current, held: null, key: selectReportKey(mergeHeld(current.entries, current.held), current.entries, current.key) } : current), []);
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
    // 붙들기는 카드 질문 장(`cq_`)에만 쓴다. 일반 질문 장의 답까지 붙들지 않는다.
    hold: (entry, option) => setScope(current => {
      if (!entry.key.startsWith('cq_')) return current;
      const merged = mergeHeld(current.entries, current.held);
      const index = merged.findIndex(item => item.key === entry.key);
      if (index < 0) return current;
      return { ...current, held: { entry, answer: option, index, siblings: sameCardSiblings(merged, entry), provisional: true } };
    }),
    confirm: key => setScope(current => current.held?.provisional && current.held.entry.key === key ? { ...current, held: { ...current.held, provisional: false } } : current),
    release: key => setScope(current => current.held?.provisional && current.held.entry.key === key ? { ...current, held: null } : current),
    answeredHoldKey: scope.held && !scope.held.provisional ? scope.held.entry.key : null,
    expire,
  };
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}

export function usePersistentReport() { return useContext(Context); }
