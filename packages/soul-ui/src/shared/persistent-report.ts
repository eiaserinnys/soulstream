import type { PersistentReportEntry } from './session-types';

export type ReportContextItem = { key: string; content: Record<string, unknown> };
export type ReportSendContext = { contextItems?: ReportContextItem[]; persistentReportSource?: PersistentReportEntry };
export type ReportReplyReceipt = { key: string; option: string; line: string };
export const EMPTY_REPORT: PersistentReportEntry[] = [];
export function containsReportReply(text: string, line: string): boolean {
  return (`\n${text}\n`).includes(`\n${line}\n`);
}

export function selectReportKey(previous: PersistentReportEntry[], next: PersistentReportEntry[], key: string | null): string | null {
  if (next.some(entry => entry.key === key)) return key;
  const index = Math.max(0, previous.findIndex(entry => entry.key === key));
  return next[Math.min(index, next.length - 1)]?.key ?? null;
}

export function reportMessageContext(entries: PersistentReportEntry[], visibleKey: string | null, receipt: ReportReplyReceipt | null, text: string): ReportSendContext {
  const reply = receipt && containsReportReply(text, receipt.line) ? entries.find(entry => entry.key === receipt.key) : undefined;
  if (reply?.kind === 'ask') return {
    contextItems: [{ key: 'persistent_report_reply', content: { key: reply.key, option: receipt!.option } }],
    persistentReportSource: reply,
  };
  const visible = entries.find(entry => entry.key === visibleKey);
  return visible ? { contextItems: [{ key: 'persistent_report_visible', content: { key: visible.key, title: visible.title } }] } : {};
}
