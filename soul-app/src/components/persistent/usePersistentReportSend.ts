import { useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { PersistentReportEntry, Session } from '../../api/types';
import { pendingReportReply, reportSendContext } from '../../lib/persistent-report';
import { createOptimisticUserEvent, pickOptimisticVariant, useChatStore, type PendingOptimisticEvent } from '../../store/chatStore';
import { getSendFailureReason } from '../chat/useChatSendFlow';

export const FAILED_REPORT_SEND_REMAINS = '보내지 못한 글이 대화에 남아 있어. 다시 보내거나 입력창으로 옮겨 줘.';
const edition = (entry: PersistentReportEntry) => JSON.stringify([entry.key, entry.updated_at]);
/** Report sends own no draft or attachment state. They share the ordinary per-session pending slot. */
export function usePersistentReportSend(sessionId: string, api: ApiClient | null, entries: PersistentReportEntry[],
  base: PersistentReportEntry[], status: Session['status'] | undefined, setNotice: (text: string) => void) {
  const pending = useChatStore(state => state.pendingOptimisticBySession[sessionId]);
  const [state, setState] = useState(() => ({ sessionId, acceptedId: '',
    replies: new Map<string, { base: PersistentReportEntry[]; option: string }>(), cancelled: new Set<string>() }));
  if (state.sessionId !== sessionId) setState({ sessionId, acceptedId: '', replies: new Map(), cancelled: new Set() });
  const current = state.sessionId === sessionId;
  const busy = pending?.pendingStatus === 'sending' && (!current || pending.id !== state.acceptedId);
  const sendingReply = pending?.pendingStatus === 'sending' && pending.reportBase === base ? pendingReportReply(pending.contextItems) : undefined;
  const shown = entries.map(entry => {
    const receipt = current ? state.replies.get(edition(entry)) : undefined;
    const option = sendingReply?.key === entry.key ? sendingReply.option : receipt?.base === base ? receipt.option : undefined;
    return option !== undefined && entry.kind === 'ask' && entry.state === 'open' ? { ...entry, state: 'answered' as const, answer: option } : entry;
  });
  async function send(entry: PersistentReportEntry, option?: string) {
    if (!api || !sessionId) return;
    const store = useChatStore.getState();
    const slot = store.pendingOptimisticBySession[sessionId];
    if (slot?.pendingStatus === 'sending' && slot.id !== state.acceptedId) return;
    const text = option === undefined ? `${entry.title}: 답을 취소합니다` : `${entry.title}: ${option}`;
    const ownFailed = slot?.pendingStatus === 'failed' && option !== undefined
      && slot.originalText === text && slot.reportReply?.key === entry.key && slot.reportReply.option === option;
    if (slot?.pendingStatus === 'failed' && !ownFailed) { setNotice(FAILED_REPORT_SEND_REMAINS); return; }
    const message: PendingOptimisticEvent = ownFailed ? { ...slot, pendingStatus: 'sending' }
      : { ...createOptimisticUserEvent(text, pickOptimisticVariant(status)), pendingStatus: 'sending',
        originalText: text, attachmentItems: [], ...reportSendContext(base, entry.key, text,
          option === undefined ? null : { key: entry.key, option, text }) };
    if (ownFailed) store.updatePendingOptimisticStatus(sessionId, message.id, 'sending');
    else store.setPendingOptimistic(sessionId, message, true);
    const id = edition(entry);
    try {
      const verdict = await api.intervene(sessionId, text, undefined, message.contextItems);
      if (verdict.delivered === null || verdict.outcome === 'unknown') {
        useChatStore.getState().updatePendingOptimisticStatus(sessionId, message.id, 'failed', '전달을 확인하지 못했습니다');
        return;
      }
      setState(saved => {
        if (saved.sessionId !== sessionId) return saved;
        const replies = new Map(saved.replies), cancelled = new Set(saved.cancelled);
        if (option === undefined) cancelled.add(id); else replies.set(id, { base, option });
        return { ...saved, acceptedId: message.id, replies, cancelled };
      });
    } catch (error) {
      useChatStore.getState().updatePendingOptimisticStatus(sessionId, message.id, 'failed', getSendFailureReason(error));
    }
  }
  return { entries: shown, busy,
    canCancel: (entry: PersistentReportEntry) => base.some(saved => edition(saved) === edition(entry) && saved.state === 'answered')
      || (current && state.replies.get(edition(entry))?.base === base),
    cancelSent: (entry: PersistentReportEntry) => current && state.cancelled.has(edition(entry)),
    sendOption: (entry: PersistentReportEntry, option: string) => send(entry, option),
    cancel: (entry: PersistentReportEntry) => send(entry),
  };
}
