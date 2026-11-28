import { useTranslation } from "react-i18next";
import { usePersistentReport } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import type { PersistentReportEntry } from '../../../packages/wire-schema/src/persistent_report';
import { useDashboardStore } from '@seosoyoung/soul-ui';
import type { PendingChatSend } from '@seosoyoung/soul-ui/stores/dashboard-store-types';
import { submitIntervention, SubmitInterventionHttpError } from '@seosoyoung/soul-ui/components/chat/submitIntervention';

/** Uses the existing per-session chat send slot without touching the composer. */
export function usePersistentReportSend(sessionId: string, notify: (text: string) => void, transport = submitIntervention) {
  const { t } = useTranslation();
  const pending = useDashboardStore(state => state.pendingChatSends[sessionId]);
  const report = usePersistentReport()!;
  const start = (entry: PersistentReportEntry, kind: 'reply' | 'cancel' | 'close', option?: string) => {
    const state = useDashboardStore.getState();
    const current = state.pendingChatSends[sessionId];
    if (current?.status === 'sending') return null;
    const text = `${entry.title}: ${kind === 'reply' ? option! : kind === 'close' ? '확인했어' : '답을 취소합니다'}`; // i18n-ignore: 담당 세션으로 보내는 확인 및 취소 메시지 본문이다.
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
    if (current && !isSameFailure) { notify(t("persistent.report.retainedFailure")); return null; }
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
      if (result.delivered === null) throw new Error(t("persistent.report.unknownDelivery"));
      const current = useDashboardStore.getState().pendingChatSends[sessionId];
      if (current?.id === next.id) {
        if (result.reason === 'card_question_answered') {
          state.setPendingChatSend(sessionId, null);
          return true;
        }
        if (current.persistentReportOperation) state.setPendingChatSend(sessionId, { ...current, persistentReportOperation: { ...current.persistentReportOperation, acknowledged: true } });
      }
      // The ordinary chat event reconciles this pending slot, as for composer sends.
      return true;
    } catch (error) {
      const current = useDashboardStore.getState().pendingChatSends[sessionId];
      if (current?.id === next.id) {
        let reason = t("persistent.report.unknownDelivery");
        if (error instanceof SubmitInterventionHttpError) {
          const { message, status } = error;
          const hasDetail = Boolean(message) && message !== "알 수 없는 오류" && message !== `HTTP ${status}`; // i18n-ignore: 공유 전송 함수가 상세 없이 만든 기본 오류값과 비교한다.
          reason = hasDetail
            ? t("persistent.report.sendFailed", { detail: message })
            : t("persistent.report.sendFailedWithoutDetail");
        }
        state.setPendingChatSend(sessionId, { ...current, status: 'failed', reason });
      }
      return false;
    }
  };
  const send = async (entry: PersistentReportEntry, kind: 'reply' | 'cancel', option?: string) => {
    const next = start(entry, kind, option);
    return next ? await deliver(next) : false;
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
