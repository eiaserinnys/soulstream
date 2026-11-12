import { useOptionalLayoutContinuity } from '../../navigation/LayoutContinuityContext';
import { useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { PersistentReportEntry } from '../../api/types';
import { CARD_ENTRY_KEY_PREFIX, CARD_QUESTION_KEY_PREFIX } from '../../../../packages/wire-schema/src/persistent_report';
import { EMPTY_REPORT, pendingReportReply, reportSendContext, type ReportReplyDraft } from '../../lib/persistent-report';
import { useSessionStore } from '../../store/sessionStore';
import type { PendingOptimisticEvent } from '../../store/chatStore';

function dismissalId(sessionId: string | undefined, entry: PersistentReportEntry): string {
  return JSON.stringify([sessionId, entry.key, entry.updated_at]);
}
const edition = (entry: Pick<PersistentReportEntry, 'key' | 'updated_at'>) => JSON.stringify([entry.key, entry.updated_at]);
type AnsweredHold = { sessionId: string | undefined; key: string; index: number; cardId: string | null;
  seen: Set<string>; entry: PersistentReportEntry; confirmed: boolean };
/** 답을 보내기 시작할 때 잠정으로 붙들고, 성공하면 확정하고, 실패하면 놓는 손잡이(화면 계약 판 5, 3절 2번). */
export type CardQuestionAnswerHold = {
  begin(entry: PersistentReportEntry, option: string): void;
  confirm(entry: PersistentReportEntry, option: string): void;
  release(entry: PersistentReportEntry): void;
};
const isCardBoardEntry = (entry: PersistentReportEntry) =>
  entry.key.startsWith(CARD_QUESTION_KEY_PREFIX) || entry.key.startsWith(CARD_ENTRY_KEY_PREFIX);

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
  // 이 화면에서 답을 보낸 카드 질문 장은 서버 판에서 빠진 뒤에도 같은 자리에 「답 받음」으로 남긴다.
  // 잠정 붙들기는 보내기 시작과 함께 걸려, 판 갱신이 응답보다 먼저 장을 빼도 자리를 지킨다.
  const [answeredHold, setAnsweredHold] = useState<AnsweredHold | null>(null);
  const currentHold = answeredHold && answeredHold.sessionId === sessionId ? answeredHold : null;
  if (answeredHold && answeredHold.sessionId !== sessionId) setAnsweredHold(null);
  const holdReleased = currentHold !== null && currentHold.confirmed && server.some(entry => isCardBoardEntry(entry)
    && (currentHold.cardId !== null ? entry.card_id === currentHold.cardId : entry.key === currentHold.key)
    && !currentHold.seen.has(edition(entry)));
  if (holdReleased) setAnsweredHold(null);
  const hold = holdReleased ? null : currentHold;
  const heldEntries = hold && !projectedEntries.some(entry => entry.key === hold.key)
    ? [...projectedEntries.slice(0, Math.min(hold.index, projectedEntries.length)), hold.entry,
      ...projectedEntries.slice(Math.min(hold.index, projectedEntries.length))]
    : projectedEntries;
  const found = view.sessionId === sessionId ? heldEntries.findIndex(entry => entry.key === view.key) : -1;
  const index = found >= 0 ? found : Math.max(0, Math.min(view.sessionId === sessionId ? view.index : 0, heldEntries.length - 1));
  const key = heldEntries[index]?.key;
  if ((live !== undefined || snapshot !== undefined) && view.sessionId === sessionId && (view.key !== key || view.index !== index)) setView({ ...view, key, index });
  const reply = pending?.pendingStatus === 'sending' && pending.reportBase === server
    ? pendingReportReply(pending.contextItems) : undefined;
  const entries = reply ? heldEntries.map(entry => entry.key === reply.key && entry.kind === 'ask' && entry.state === 'open'
    ? { ...entry, state: 'answered' as const, answer: reply.option } : entry) : heldEntries;

  return {
    entries, index, server,
    /** 답 보내기를 시작할 때 그 질문 장을 같은 key, 같은 자리에 잠정으로 붙든다. */
    beginAnsweredHold(entry: PersistentReportEntry, option: string) {
      if (!entry.key.startsWith(CARD_QUESTION_KEY_PREFIX)) return;
      const cardId = entry.card_id ?? null;
      const position = entries.findIndex(item => item.key === entry.key);
      const targetIndex = position >= 0 ? position : Math.max(0, Math.min(index, entries.length - 1));
      const seen = new Set(server.filter(item => isCardBoardEntry(item)
        && (cardId !== null ? item.card_id === cardId : item.key === entry.key)).map(edition));
      seen.add(edition(entry));
      setAnsweredHold({ sessionId, key: entry.key, index: targetIndex, cardId, seen,
        entry: { ...entry, state: 'answered' as const, answer: option }, confirmed: false });
    },
    /** 답이 성공하면 잠정으로 붙든 장을 「답 받음」으로 확정한다(덧붙이기 대상은 호출자가 세운다). */
    holdAnswered(entry: PersistentReportEntry, option: string) {
      setAnsweredHold(current => current && current.sessionId === sessionId && current.key === entry.key
        ? { ...current, confirmed: true, entry: { ...current.entry, state: 'answered' as const, answer: option } }
        : current);
    },
    /** 답을 보내지 못하면 잠정 붙들기를 놓고 판 재계산대로 둔다. */
    releaseAnsweredHold(entry: PersistentReportEntry) {
      setAnsweredHold(current => current && current.sessionId === sessionId && current.key === entry.key
        && !current.confirmed ? null : current);
    },
    select(index: number) {
      const next = Math.max(0, Math.min(entries.length - 1, index));
      if (answeredHold && answeredHold.sessionId === sessionId && entries[next]?.key !== answeredHold.key) setAnsweredHold(null);
      continuity?.setViewState(memoryKey, { ...continuity.getViewState<object>(memoryKey), reportKey: entries[next]?.key, reportIndex: next });
      setView(current => ({ ...current, index: next, key: entries[next]?.key }));
    },
    getSendContext(text: string, reply: ReportReplyDraft | null, visible = true) {
      // The reply baseline stays the server list; the visible reference follows the projection.
      return reportSendContext(server, visible ? key : undefined, text, reply, entries);
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
