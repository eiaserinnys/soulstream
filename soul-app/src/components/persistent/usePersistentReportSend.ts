import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { PersistentReportEntry, Session } from '../../api/types';
import { pendingReportClosed, pendingReportReply, reportSendContext } from '../../lib/persistent-report';
import { createOptimisticUserEvent, pickOptimisticVariant, useChatStore, type PendingOptimisticEvent } from '../../store/chatStore';
import { getSendFailureReason, CARD_QUESTION_ANSWERED_REASON } from '../chat/useChatSendFlow';

export const FAILED_REPORT_SEND_REMAINS = '보내지 못한 글이 대화에 남아 있어. 다시 보내거나 입력창으로 옮겨 줘.';
const edition = (entry: Pick<PersistentReportEntry, 'key' | 'updated_at'>) => JSON.stringify([entry.key, entry.updated_at]);
/** Report sends own no draft or attachment state. They share the ordinary per-session pending slot. */
export function usePersistentReportSend(sessionId: string, api: ApiClient | null, entries: PersistentReportEntry[],
  base: PersistentReportEntry[], status: Session['status'] | undefined, setNotice: (text: string) => void) {
  const pending = useChatStore(state => state.pendingOptimisticBySession[sessionId]);
  const [state, setState] = useState(() => ({ sessionId, acceptedId: '',
    replies: new Map<string, { base: PersistentReportEntry[]; option: string }>(), cancelled: new Set<string>() }));
  if (state.sessionId !== sessionId) setState({ sessionId, acceptedId: '', replies: new Map(), cancelled: new Set() });
  else if ([...state.cancelled].some(id => !entries.some(entry => edition(entry) === id))) {
    setState({ ...state, cancelled: new Set([...state.cancelled].filter(id => entries.some(entry => edition(entry) === id))) });
  }
  // The pending slot is the owner. Observe its retirement once; both direct
  // sends and the conversation's retry retain the same publication marker.
  useEffect(() => useChatStore.subscribe((next, previous) => {
    const sent = previous.pendingOptimisticBySession[sessionId];
    if (!sent?.reportCancellation || next.pendingOptimisticBySession[sessionId]?.id === sent.id) return;
    // mergeEvents retires this exact slot together with its accepted server
    // event. Restore/delete only clears the slot; old history is never scanned.
    if (!next.eventsBySession[sessionId]
      || next.eventsBySession[sessionId] === previous.eventsBySession[sessionId]) return;
    const id = edition(sent.reportCancellation);
    setState(saved => saved.sessionId !== sessionId || saved.cancelled.has(id) ? saved
      : { ...saved, cancelled: new Set([...saved.cancelled, id]) });
  }), [sessionId]);
  const current = state.sessionId === sessionId;
  const busy = pending?.pendingStatus === 'sending' && (!current || pending.id !== state.acceptedId);
  const sendingReply = pending?.pendingStatus === 'sending' && pending.reportBase === base ? pendingReportReply(pending.contextItems) : undefined;
  const shown = entries.map(entry => {
    const receipt = current ? state.replies.get(edition(entry)) : undefined;
    const option = sendingReply?.key === entry.key ? sendingReply.option : receipt?.base === base ? receipt.option : undefined;
    return option !== undefined && entry.kind === 'ask' && entry.state === 'open' ? { ...entry, state: 'answered' as const, answer: option } : entry;
  });
  function start(entry: PersistentReportEntry, kind: 'reply' | 'cancel' | 'close', option?: string) {
    if (!api || !sessionId) return null;
    const store = useChatStore.getState();
    const slot = store.pendingOptimisticBySession[sessionId];
    if (slot?.pendingStatus === 'sending' && slot.id !== state.acceptedId) return null;
    const text = `${entry.title}: ${kind === 'reply' ? option! : kind === 'close' ? '확인했어' : '답을 취소합니다'}`;
    const closed = pendingReportClosed(slot?.contextItems);
    const ownFailed = slot?.pendingStatus === 'failed' && slot.originalText === text && (kind === 'reply'
      ? slot.reportReply?.key === entry.key && slot.reportReply.option === option
      : kind === 'close' && slot.contextItems?.length === 1
        && closed?.key === entry.key && closed?.title === entry.title);
    if (slot?.pendingStatus === 'failed' && !ownFailed) { setNotice(FAILED_REPORT_SEND_REMAINS); return null; }
    const context = kind === 'close' ? { contextItems: [{ key: 'persistent_report_closed', content: { key: entry.key, title: entry.title } }] }
      : reportSendContext(base, entry.key, text, kind === 'reply' ? { key: entry.key, option: option!, text } : null);
    const message: PendingOptimisticEvent = ownFailed ? { ...slot, pendingStatus: 'sending' }
      : { ...createOptimisticUserEvent(text, pickOptimisticVariant(status)), pendingStatus: 'sending',
        originalText: text, attachmentItems: [], ...context,
        ...(kind === 'cancel' ? { reportCancellation: { key: entry.key, updated_at: entry.updated_at } } : {}) };
    if (ownFailed) store.updatePendingOptimisticStatus(sessionId, message.id, 'sending');
    else store.setPendingOptimistic(sessionId, message, true);
    return message;
  }
  async function deliver(entry: PersistentReportEntry, message: PendingOptimisticEvent, kind: 'reply' | 'cancel' | 'close', text: string, option?: string) {
    if (!api || !sessionId) return;
    const id = edition(entry);
    try {
      const verdict = await api.intervene(sessionId, text, undefined, message.contextItems);
      if (verdict.delivered === null || verdict.outcome === 'unknown') {
        useChatStore.getState().updatePendingOptimisticStatus(sessionId, message.id, 'failed', '전달을 확인하지 못했습니다');
        return;
      }
      // 판의 카드 질문 답은 PAS 채팅 echo가 없으므로 접수 reason으로 같은 요청 ID의 슬롯을 직접 정리한다.
      // 합성 user 이벤트를 만들지 않는다.
      if (verdict.reason === CARD_QUESTION_ANSWERED_REASON) {
        useChatStore.getState().clearPendingOptimistic(sessionId, message.id);
      }
      setState(saved => {
        if (saved.sessionId !== sessionId) return saved;
        const replies = new Map(saved.replies);
        if (kind === 'reply') replies.set(id, { base, option: option! });
        return { ...saved, acceptedId: message.id, replies };
      });
    } catch (error) {
      useChatStore.getState().updatePendingOptimisticStatus(sessionId, message.id, 'failed', getSendFailureReason(error));
    }
  }
  async function send(entry: PersistentReportEntry, kind: 'reply' | 'cancel', option?: string) {
    const message = start(entry, kind, option);
    if (message) await deliver(entry, message, kind, `${entry.title}: ${kind === 'reply' ? option! : '답을 취소합니다'}`, option);
  }
  return { entries: shown, busy,
    canCancel: (entry: PersistentReportEntry) => base.some(saved => edition(saved) === edition(entry) && saved.state === 'answered'),
    cancelSent: (entry: PersistentReportEntry) => pending?.reportCancellation && edition(pending.reportCancellation) === edition(entry)
      ? pending.pendingStatus === 'sending' : current && state.cancelled.has(edition(entry)),
    sendOption: (entry: PersistentReportEntry, option: string) => send(entry, 'reply', option),
    cancel: (entry: PersistentReportEntry) => send(entry, 'cancel'),
    close: (entry: PersistentReportEntry) => {
      const message = start(entry, 'close');
      if (!message) return false;
      void deliver(entry, message, 'close', `${entry.title}: 확인했어`);
      return true;
    },
  };
}
