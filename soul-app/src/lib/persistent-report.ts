import type { MessageContextItem, PersistentReportEntry } from '../api/types';

export type ReportReplyDraft = { key: string; option: string; text: string };
export type ReportSendContext = {
  contextItems?: MessageContextItem[];
  reportBase?: PersistentReportEntry[];
  reportReply?: ReportReplyDraft;
};
export const EMPTY_REPORT: PersistentReportEntry[] = [];

export function isReportReply(text: string, reply: ReportReplyDraft | null | undefined): reply is ReportReplyDraft {
  return !!reply && text.trim() === reply.text;
}

export function reportSendContext(entries: PersistentReportEntry[], visibleKey: string | undefined,
  text: string, reply: ReportReplyDraft | null, visibleEntries: PersistentReportEntry[] = entries): ReportSendContext {
  if (isReportReply(text, reply)) return {
    contextItems: [{ key: 'persistent_report_reply', content: { key: reply.key, option: reply.option } }],
    reportBase: entries, reportReply: reply,
  };
  const visible = visibleEntries.find(entry => entry.key === visibleKey);
  return visible ? { contextItems: [{ key: 'persistent_report_visible', content: { key: visible.key, title: visible.title } }] } : {};
}

export function pendingReportReply(contextItems: MessageContextItem[] | undefined): { key: string; option: string } | undefined {
  return contextItems?.find(item => item.key === 'persistent_report_reply')?.content as { key: string; option: string } | undefined;
}

export function pendingReportClosed(contextItems: MessageContextItem[] | undefined): { key: string; title: string } | undefined {
  return contextItems?.find(item => item.key === 'persistent_report_closed')?.content as { key: string; title: string } | undefined;
}
