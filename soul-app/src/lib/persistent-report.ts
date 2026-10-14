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
  text: string, reply: ReportReplyDraft | null): ReportSendContext {
  if (isReportReply(text, reply)) return {
    contextItems: [{ key: 'persistent_report_reply', content: { key: reply.key, option: reply.option } }],
    reportBase: entries, reportReply: reply,
  };
  const visible = entries.find(entry => entry.key === visibleKey);
  return visible ? { contextItems: [{ key: 'persistent_report_visible', content: { key: visible.key, title: visible.title } }] } : {};
}

export function pendingReportReply(contextItems: MessageContextItem[] | undefined): { key: string; option: string } | undefined {
  return contextItems?.find(item => item.key === 'persistent_report_reply')?.content as { key: string; option: string } | undefined;
}

export function pendingReportClosed(contextItems: MessageContextItem[] | undefined): { key: string; title: string } | undefined {
  return contextItems?.find(item => item.key === 'persistent_report_closed')?.content as { key: string; title: string } | undefined;
}

/** Server permits plain text and https markdown links only. */
export function reportActionParts(text: string): Array<string | { label: string; url: string }> {
  const parts: Array<string | { label: string; url: string }> = [];
  const pattern = /\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > start) parts.push(text.slice(start, match.index));
    parts.push({ label: match[1], url: match[2] });
    start = match.index + match[0].length;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}
