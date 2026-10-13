/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDashboardStore, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import { PersistentReportProvider } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { usePersistentReportSend } from './usePersistentReportSend';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const entry: PersistentReportEntry = { key: 'one', kind: 'ask', title: '확인', context: '맥락', action: '선택', options: ['응'], card_numbers: [], state: 'open', answer: '', updated_at: 'one' };
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>; let send: ReturnType<typeof usePersistentReportSend>;
const notify = vi.fn(); const transport = vi.fn();
function Harness() { send = usePersistentReportSend('a', notify, transport); return null; }
beforeEach(async () => { vi.clearAllMocks(); useDashboardStore.getState().setPendingChatSend('a', null); transport.mockReset(); transport.mockResolvedValue({ ok: true, delivered: true, reason: null, consumeWhen: null }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<PersistentReportProvider sessionId="a" entries={[entry]}><Harness/></PersistentReportProvider>)); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
it('preserves drafts and allows cancellation only after the server publishes its answered revision', async () => {
  let resolve!: (value: unknown) => void; transport.mockReturnValue(new Promise(yes => { resolve = yes; }));
  useDashboardStore.getState().setDraft('a', '쓰던 글');
  let request!: Promise<void>;
  await act(async () => { request = send.reply(entry, '응'); });
  expect(useDashboardStore.getState().pendingChatSends.a).toMatchObject({ status: 'sending', text: '확인: 응', attachmentPaths: [], contextItems: [{ key: 'persistent_report_reply', content: { key: 'one', option: '응' } }], persistentReportSource: entry });
  expect(send.canCancel(entry)).toBe(false);
  expect(useDashboardStore.getState().drafts.a).toBe('쓰던 글');
  await act(async () => { resolve({ ok: true, delivered: true }); await request; });
  expect(send.canCancel(entry)).toBe(false);
  const confirmed={...entry,state:'answered' as const,answer:'응',updated_at:'server-answered'};
  await act(async()=>root.render(<PersistentReportProvider sessionId="a" entries={[confirmed]}><Harness/></PersistentReportProvider>));
  expect(send.canCancel(confirmed)).toBe(true);
  await act(async()=>useDashboardStore.getState().setPendingChatSend('a',null));
  await act(async()=>send.cancel(confirmed));
  expect(useDashboardStore.getState().pendingChatSends.a.persistentReportOperation).toMatchObject({kind:'cancel',updatedAt:'server-answered'});
  await act(async()=>useDashboardStore.getState().setPendingChatSend('a',null));
  await act(async()=>root.render(<PersistentReportProvider sessionId="a" entries={[{...confirmed}]}><Harness/></PersistentReportProvider>));
  expect(send.cancelRequested(confirmed)).toBe(true);
});
it('disables while any message is sending, and explains a retained unrelated failure on the existing notice', async () => {
  const pending = { id: 'other', status: 'sending' as const, text: '다른 글', messageText: '다른 글', mode: 'intervention' as const, attachments: [], attachmentPaths: [] };
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', pending));
  expect(send.sending).toBe(true); await act(async () => send.reply(entry, '응')); expect(transport).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', { ...pending, status: 'failed' }));
  expect(send.sending).toBe(false); await act(async () => send.reply(entry, '응'));
  expect(notify).toHaveBeenCalledWith('보내지 못한 글이 대화에 남아 있어. 다시 보내거나 입력창으로 옮겨 줘.'); expect(transport).not.toHaveBeenCalled();
});
it('retains failures in the chat slot and retries the same answer with the same ID', async () => {
  transport.mockRejectedValueOnce(new Error('offline'));
  await act(async () => send.reply(entry, '응'));
  const failed = useDashboardStore.getState().pendingChatSends.a;
  expect(failed.status).toBe('failed'); expect(send.canCancel(entry)).toBe(false); expect(notify).not.toHaveBeenCalled();
  await act(async () => send.reply(entry, '응'));
  expect(useDashboardStore.getState().pendingChatSends.a).toMatchObject({ id: failed.id, status: 'sending' }); expect(send.canCancel(entry)).toBe(false);
});
it('treats unknown delivery as failure', async () => {
  transport.mockResolvedValueOnce({ ok: true, delivered: null }); await act(async () => send.reply(entry, '응'));
  expect(useDashboardStore.getState().pendingChatSends.a.status).toBe('failed'); expect(send.canCancel(entry)).toBe(false);
});
it('sends cancellation as a normal visible-context message, keeps its label until the publication changes, and restores it on failure', async () => {
  const answered = { ...entry, state: 'answered' as const, answer: '응' };
  expect(send.canCancel(answered)).toBe(true);
  transport.mockRejectedValueOnce(new Error('offline')); await act(async () => send.cancel(answered));
  expect(send.cancelRequested(answered)).toBe(false);
  expect(transport).toHaveBeenLastCalledWith(expect.objectContaining({ text: '확인: 답을 취소합니다', contextItems: [{ key: 'persistent_report_visible', content: { key: 'one', title: '확인' } }] }));
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', null));
  await act(async () => send.cancel(answered)); expect(send.cancelRequested(answered)).toBe(true);
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', null)); expect(send.cancelRequested(answered)).toBe(true);
  expect(send.cancelRequested({ ...answered, updated_at: 'new' })).toBe(false);
});

it.each(['reply', 'cancel'] as const)('follows existing chat retry acknowledgements for %s and keeps the publication receipt', async kind => {
  transport.mockRejectedValueOnce(new Error('offline'));
  await act(async () => kind === 'reply' ? send.reply(entry, '응') : send.cancel(entry));
  const failed = useDashboardStore.getState().pendingChatSends.a;
  expect(failed.persistentReportOperation).toMatchObject({ key: entry.key, updatedAt: entry.updated_at, kind });
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', { ...failed, status: 'sending', reason: undefined }));
  expect(send.canCancel(entry)).toBe(false);
  if (kind === 'cancel') expect(send.cancelRequested(entry)).toBe(true);
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', { ...failed, status: 'sending', persistentReportOperation: { ...failed.persistentReportOperation!, acknowledged: true } }));
  if (kind === 'reply') expect(send.canCancel(entry)).toBe(false);
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', null));
  expect(kind === 'reply' ? send.canCancel(entry) : send.cancelRequested(entry)).toBe(kind === 'cancel');
  await act(async () => root.render(<PersistentReportProvider sessionId="a" entries={[{ ...entry, updated_at: 'new' }]}><Harness/></PersistentReportProvider>));
  expect(kind === 'reply' ? send.canCancel(entry) : send.cancelRequested(entry)).toBe(false);
});

it('retries the same publication after SSE replaces its object, using the current source', async () => {
  transport.mockRejectedValueOnce(new Error('offline')); await act(async () => send.reply(entry, '응'));
  const id = useDashboardStore.getState().pendingChatSends.a.id;
  const repeated = { ...entry }; await act(async () => root.render(<PersistentReportProvider sessionId="a" entries={[repeated]}><Harness/></PersistentReportProvider>));
  await act(async () => send.reply(repeated, '응'));
  expect(transport).toHaveBeenCalledTimes(2); expect(notify).not.toHaveBeenCalled();
  expect(useDashboardStore.getState().pendingChatSends.a).toMatchObject({ id, persistentReportSource: repeated });
});
it('does not reuse a previous publication cancellation failure', async () => {
  transport.mockRejectedValueOnce(new Error('offline')); await act(async () => send.cancel(entry));
  await act(async () => send.cancel({ ...entry, updated_at: 'new' }));
  expect(transport).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledOnce();
});
