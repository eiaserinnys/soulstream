import { useState } from 'react';
import { useDashboardStore, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import type { PendingChatSend } from '@seosoyoung/soul-ui/stores/dashboard-store-types';
import { submitIntervention, SubmitInterventionHttpError } from '@seosoyoung/soul-ui/components/chat/submitIntervention';

const RETAINED_FAILURE = '보내지 못한 글이 대화에 남아 있어. 다시 보내거나 입력창으로 옮겨 줘.';
const UNKNOWN_DELIVERY = '전달을 확인하지 못했습니다';
/** Uses the existing per-session chat send slot without touching the composer. */
export function usePersistentReportSend(sessionId: string, notify: (text: string) => void, transport = submitIntervention) {
  const pending = useDashboardStore(state => state.pendingChatSends[sessionId]);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [cancelled, setCancelled] = useState<Record<string, string>>({});
  const publication = (entry: PersistentReportEntry) => JSON.stringify([sessionId, entry.key, entry.updated_at]);
  const send = async (entry: PersistentReportEntry, option?: string) => {
    const state = useDashboardStore.getState();
    const current = state.pendingChatSends[sessionId];
    if (current?.status === 'sending') return;
    const text = `${entry.title}: ${option ?? '답을 취소합니다'}`;
    const stamp = publication(entry);
    const isSameFailure = current?.status === 'failed' && current.messageText === text
      && (option === undefined
        ? current.contextItems?.some(item => item.key === 'persistent_report_visible' && item.content.key === entry.key)
        : current.persistentReportSource === entry && current.contextItems?.some(item => item.key === 'persistent_report_reply' && item.content.option === option));
    if (current && !isSameFailure) { notify(RETAINED_FAILURE); return; }
    const next: PendingChatSend = isSameFailure ? { ...current!, status: 'sending', reason: undefined } : {
      id: crypto.randomUUID(), status: 'sending', text, messageText: text, attachments: [], attachmentPaths: [], mode: 'intervention',
      ...(option === undefined ? { contextItems: [{ key: 'persistent_report_visible', content: { key: entry.key, title: entry.title } }] }
        : { persistentReportSource: entry, contextItems: [{ key: 'persistent_report_reply', content: { key: entry.key, option } }] }),
    };
    state.setPendingChatSend(sessionId, next);
    if (option === undefined) setCancelled(previous => ({ ...previous, [stamp]: next.id }));
    try {
      const result = await transport({ sessionKey: sessionId, text: next.messageText, contextItems: next.contextItems });
      if (result.delivered === null) throw new Error(UNKNOWN_DELIVERY);
      if (option !== undefined) setAccepted(previous => ({ ...previous, [stamp]: true }));
      // The ordinary chat event reconciles this pending slot, as for composer sends.
    } catch (error) {
      const current = useDashboardStore.getState().pendingChatSends[sessionId];
      if (current?.id === next.id) state.setPendingChatSend(sessionId, { ...current, status: 'failed', reason: error instanceof SubmitInterventionHttpError ? `전송하지 못했습니다: ${error.message}` : UNKNOWN_DELIVERY });
      if (option === undefined) setCancelled(previous => { const updated = { ...previous }; delete updated[stamp]; return updated; });
      else setAccepted(previous => ({ ...previous, [stamp]: false }));
    }
  };
  return {
    sending: pending?.status === 'sending',
    reply: (entry: PersistentReportEntry, option: string) => send(entry, option),
    cancel: (entry: PersistentReportEntry) => send(entry),
    canCancel: (entry: PersistentReportEntry) => entry.state === 'answered' || accepted[publication(entry)] === true,
    cancelRequested: (entry: PersistentReportEntry) => {
      const id = cancelled[publication(entry)];
      return Boolean(id && !(pending?.id === id && pending.status === 'failed'));
    },
  };
}
