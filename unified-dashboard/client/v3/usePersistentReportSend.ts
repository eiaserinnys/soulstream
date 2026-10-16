import { usePersistentReport } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { useDashboardStore, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import type { PendingChatSend } from '@seosoyoung/soul-ui/stores/dashboard-store-types';
import { submitIntervention, SubmitInterventionHttpError } from '@seosoyoung/soul-ui/components/chat/submitIntervention';

const RETAINED_FAILURE = '보내지 못한 글이 대화에 남아 있어. 다시 보내거나 입력창으로 옮겨 줘.';
const UNKNOWN_DELIVERY = '전달을 확인하지 못했습니다';
/** Uses the existing per-session chat send slot without touching the composer. */
export function usePersistentReportSend(sessionId: string, notify: (text: string) => void, transport = submitIntervention) {
  const pending = useDashboardStore(state => state.pendingChatSends[sessionId]);
  const report = usePersistentReport()!;
  const start = (entry: PersistentReportEntry, kind: 'reply' | 'cancel' | 'close', option?: string) => {
    const state = useDashboardStore.getState();
    const current = state.pendingChatSends[sessionId];
    if (current?.status === 'sending') return null;
    const text = `${entry.title}: ${kind === 'reply' ? option! : kind === 'close' ? '확인했어' : '답을 취소합니다'}`;
    const contextItems = kind === 'reply'
      ? [{ key: 'persistent_report_reply', content: { key: entry.key, option: option! } }]
      : kind === 'close'
        ? [{ key: 'persistent_report_closed', content: { key: entry.key, title: entry.title } }]
        : [{ key: 'persistent_report_visible', content: { key: entry.key, title: entry.title } }];
    const operation = current?.persistentReportOperation;
    const isSameFailure = current?.status === 'failed' && current.messageText === text
      && operation?.key === entry.key && operation.updatedAt === entry.updated_at
      && operation.kind === kind
      && (kind === 'reply' ? current.contextItems?.some(item => item.key === 'persistent_report_reply' && item.content.option === option)
        : kind === 'close' ? current.contextItems?.length === 1 && current.contextItems[0].key === 'persistent_report_closed'
          && current.contextItems[0].content.key === entry.key && current.contextItems[0].content.title === entry.title : true);
    if (current && !isSameFailure) { notify(RETAINED_FAILURE); return null; }
    const next: PendingChatSend = isSameFailure ? { ...current!, status: 'sending', reason: undefined, ...(option !== undefined ? { persistentReportSource: entry } : {}) } : {
      persistentReportOperation: { key: entry.key, updatedAt: entry.updated_at, kind },
      id: crypto.randomUUID(), status: 'sending', text, messageText: text, attachments: [], attachmentPaths: [], mode: 'intervention',
      ...(kind === 'reply' ? { persistentReportSource: entry } : {}), contextItems,
    };
    state.setPendingChatSend(sessionId, next);
    return next;
  };
  const deliver = async (next: PendingChatSend) => {
    const state = useDashboardStore.getState();
    try {
      const result = await transport({ sessionKey: sessionId, text: next.messageText, contextItems: next.contextItems });
      if (result.delivered === null) throw new Error(UNKNOWN_DELIVERY);
      const current = useDashboardStore.getState().pendingChatSends[sessionId];
      if (current?.id === next.id && current.persistentReportOperation) state.setPendingChatSend(sessionId, { ...current, persistentReportOperation: { ...current.persistentReportOperation, acknowledged: true } });
      // The ordinary chat event reconciles this pending slot, as for composer sends.
    } catch (error) {
      const current = useDashboardStore.getState().pendingChatSends[sessionId];
      if (current?.id === next.id) state.setPendingChatSend(sessionId, { ...current, status: 'failed', reason: error instanceof SubmitInterventionHttpError ? `전송하지 못했습니다: ${error.message}` : UNKNOWN_DELIVERY });
    }
  };
  const send = async (entry: PersistentReportEntry, kind: 'reply' | 'cancel', option?: string) => {
    const next = start(entry, kind, option);
    if (next) await deliver(next);
  };
  return {
    sending: pending?.status === 'sending',
    reply: (entry: PersistentReportEntry, option: string) => send(entry, 'reply', option),
    cancel: (entry: PersistentReportEntry) => send(entry, 'cancel'),
    close: (entry: PersistentReportEntry) => {
      const next = start(entry, 'close');
      if (!next) return false;
      void deliver(next);
      return true;
    },
    canCancel: report.canCancel,
    cancelRequested: report.cancelRequested,
  };
}
