import React from 'react';
import { act, fireEvent, render, renderHook } from '@testing-library/react-native';
import { usePersistentReportSend, FAILED_REPORT_SEND_REMAINS } from '../usePersistentReportSend';
import { reportReviewEntries } from '../../../component-review/persistent-report-fixtures';
import { useChatStore, createOptimisticUserEvent } from '../../../store/chatStore';
import type { PersistentReportEntry } from '../../../api/types';
import type { ApiClient } from '../../../api/client';
import { useChatSendFlow } from '../../chat/useChatSendFlow';
import { PersistentReportPager } from '../PersistentReportPager';
import { measurePersistentReports } from '../../../test-utils/persistent-report-layout';
import { ChatUiControllerProvider } from '../../chat-ui/ChatUiControllerProvider';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

const entry = reportReviewEntries[1];
const base = [entry];
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => useChatStore.setState({ pendingOptimisticBySession: {}, eventsBySession: {} }));
function setup(intervene = jest.fn().mockResolvedValue({ delivered: true })) {
  const notice = jest.fn();
  const api = { intervene } as unknown as ApiClient;
  const hook = renderHook(({ entries }: { entries: PersistentReportEntry[] }) => usePersistentReportSend('pas', api, entries, base, 'completed', notice), { initialProps: { entries: base } });
  return { ...hook, intervene, notice };
}
test('direct reply uses the existing pending slot, reply context and no composer mutations', async () => {
  const response = deferred<{ delivered: boolean }>();
  const h = setup(jest.fn(() => response.promise));
  let send!: Promise<void>;
  act(() => { send = h.result.current.sendOption(entry, '응'); });
  expect(h.result.current.entries[0].state).toBe('answered');
  expect(h.result.current.canCancel(entry)).toBe(false);
  expect(h.result.current.busy).toBe(true);
  expect(h.intervene).toHaveBeenCalledWith('pas', `${entry.title}: 응`, undefined,
    [{ key: 'persistent_report_reply', content: { key: entry.key, option: '응' } }]);
  expect(useChatStore.getState().pendingOptimisticBySession.pas.attachmentItems).toEqual([]);
  await act(async () => { response.resolve({ delivered: true }); await send; });
  expect(h.result.current.canCancel(entry)).toBe(true);
  expect(h.result.current.busy).toBe(false);
});
test('failure reopens options; the same failed reply retries in the same pending slot', async () => {
  const intervene = jest.fn().mockRejectedValueOnce(Error('fail')).mockResolvedValueOnce({ delivered: true });
  const h = setup(intervene);
  await act(async () => h.result.current.sendOption(entry, '응'));
  const first = useChatStore.getState().pendingOptimisticBySession.pas;
  expect(first.pendingStatus).toBe('failed'); expect(h.result.current.entries[0].state).toBe('open');
  await act(async () => h.result.current.sendOption(entry, '응'));
  expect(useChatStore.getState().pendingOptimisticBySession.pas.id).toBe(first.id);
  expect(h.result.current.entries[0].state).toBe('answered'); expect(h.notice).not.toHaveBeenCalled();
});
test('another sending message disables controls without notice; unrelated failure shows the existing notice', async () => {
  const h = setup();
  const other = { ...createOptimisticUserEvent('쓰던 글', 'user_message'), pendingStatus: 'sending' as const };
  act(() => useChatStore.getState().setPendingOptimistic('pas', other));
  await act(async () => h.result.current.sendOption(entry, '응'));
  expect(h.result.current.busy).toBe(true); expect(h.intervene).not.toHaveBeenCalled(); expect(h.notice).not.toHaveBeenCalled();
  act(() => useChatStore.getState().updatePendingOptimisticStatus('pas', other.id, 'failed', 'failure'));
  await act(async () => h.result.current.sendOption(entry, '응'));
  expect(h.intervene).not.toHaveBeenCalled(); expect(h.notice).toHaveBeenCalledWith(FAILED_REPORT_SEND_REMAINS);
});
test('cancel uses visible context, survives until publication changes, and failure returns to cancel', async () => {
  const h = setup(jest.fn().mockResolvedValueOnce({ delivered: true }).mockRejectedValueOnce(Error('fail')).mockResolvedValueOnce({ delivered: true }));
  await act(async () => h.result.current.sendOption(entry, '응'));
  act(() => useChatStore.getState().clearPendingOptimistic('pas'));
  await act(async () => h.result.current.cancel(entry));
  expect(h.result.current.cancelSent(entry)).toBe(false);
  act(() => useChatStore.getState().clearPendingOptimistic('pas'));
  await act(async () => h.result.current.cancel(entry));
  expect(h.intervene.mock.calls.at(-1)).toEqual(['pas', `${entry.title}: 답을 취소합니다`, undefined,
    [{ key: 'persistent_report_visible', content: { key: entry.key, title: entry.title } }]]);
  expect(h.result.current.cancelSent(entry)).toBe(true);
  h.rerender({ entries: [{ ...entry, updated_at: 'new' }] });
  expect(h.result.current.cancelSent(h.result.current.entries[0])).toBe(false);
});

test('conversation retry preserves cancellation identity through sending, failure, arrival and republication', async () => {
  const answered = { ...entry, state: 'answered' as const, answer: '응' };
  const server = [answered];
  const retryFailure = deferred<{ delivered: boolean }>();
  const retrySuccess = deferred<{ delivered: boolean }>();
  const intervene = jest.fn().mockRejectedValueOnce(Error('cancel failed'))
    .mockImplementationOnce(() => retryFailure.promise).mockImplementationOnce(() => retrySuccess.promise);
  const api = { intervene } as unknown as ApiClient;
  const h = renderHook(({ entries }: { entries: PersistentReportEntry[] }) => ({
    report: usePersistentReportSend('pas', api, entries, server, 'completed', jest.fn()),
    conversation: useChatSendFlow({ api, sessionId: 'pas', session: { status: 'completed' },
      attachments: [], clearAttachments: jest.fn(), scrollToBottom: jest.fn() }),
  }), { initialProps: { entries: server } });
  await act(async () => h.result.current.report.cancel(answered));
  const failed = useChatStore.getState().pendingOptimisticBySession.pas;
  expect(failed.reportCancellation).toEqual({ key: answered.key, updated_at: answered.updated_at });
  expect(h.result.current.report.cancelSent(answered)).toBe(false);
  let retry!: Promise<void>;
  act(() => { retry = h.result.current.conversation.retryPendingOptimistic(failed.id); });
  expect(h.result.current.report.cancelSent(answered)).toBe(true);
  await act(async () => { retryFailure.reject(Error('retry failed')); await retry; });
  expect(h.result.current.report.cancelSent(answered)).toBe(false);
  act(() => { retry = h.result.current.conversation.retryPendingOptimistic(failed.id); });
  expect(h.result.current.report.cancelSent(answered)).toBe(true);
  await act(async () => { retrySuccess.resolve({ delivered: true }); await retry; });
  expect(h.result.current.report.cancelSent(answered)).toBe(true);
  const delivered = useChatStore.getState().pendingOptimisticBySession.pas;
  act(() => useChatStore.getState().mergeEvents('pas', [{ ...delivered, id: '42' }]));
  expect(useChatStore.getState().pendingOptimisticBySession.pas).toBeUndefined();
  expect(h.result.current.report.cancelSent(answered)).toBe(true);
  const revised = { ...answered, updated_at: '2026-10-14T00:00:00Z' };
  h.rerender({ entries: [revised] });
  expect(h.result.current.report.cancelSent(revised)).toBe(false);
  h.rerender({ entries: server });
  expect(h.result.current.report.cancelSent(answered)).toBe(false);
});

test('actual report controls hide cancellation until receipt, disable during other sends, and show the failed-slot notice', async () => {
  const response = deferred<{ delivered: boolean }>();
  const notice = jest.fn();
  const api = { intervene: jest.fn(() => response.promise) } as unknown as ApiClient;
  function Harness({ entries = base }: { entries?: PersistentReportEntry[] }) {
    const send = usePersistentReportSend('pas', api, entries, entries, 'completed', notice);
    return <ChatUiControllerProvider sessionId="pas" appendGeneratedText={() => ({ ok: true })}>
      <PersistentReportPager entries={send.entries} index={0} api={api} send={send}
        onSelect={jest.fn()} onDismiss={jest.fn()} onFocusComposer={jest.fn()} />
    </ChatUiControllerProvider>;
  }
  const screen = render(<Harness />);
  measurePersistentReports(screen);
  fireEvent.press(screen.getByLabelText('응'));
  expect(screen.queryByTestId('report-cancel')).toBeNull();
  await act(async () => { response.resolve({ delivered: true }); });
  expect(screen.getByTestId('report-cancel').props.accessibilityState.disabled).toBe(false);
  const other = { ...createOptimisticUserEvent('다른 글', 'user_message'), pendingStatus: 'sending' as const };
  act(() => useChatStore.getState().setPendingOptimistic('pas', other));
  expect(screen.getByTestId('report-cancel').props.accessibilityState.disabled).toBe(true);
  const sent = jest.mocked(api.intervene).mock.calls.length;
  fireEvent.press(screen.getByTestId('report-cancel'));
  expect(api.intervene).toHaveBeenCalledTimes(sent);
  act(() => useChatStore.getState().updatePendingOptimisticStatus('pas', other.id, 'failed', 'failure'));
  fireEvent.press(screen.getByTestId('report-cancel'));
  expect(notice).toHaveBeenCalledWith(FAILED_REPORT_SEND_REMAINS);
  act(() => useChatStore.getState().updatePendingOptimisticStatus('pas', other.id, 'sending'));
  const revised = [{ ...entry, updated_at: '2026-10-14T00:00:00Z' }];
  screen.rerender(<Harness entries={revised} />);
  measurePersistentReports(screen);
  expect(screen.getByLabelText('응').props.accessibilityState.disabled).toBe(true);
  act(() => useChatStore.getState().updatePendingOptimisticStatus('pas', other.id, 'failed', 'failure'));
  fireEvent.press(screen.getByLabelText('응'));
  expect(notice).toHaveBeenCalledWith(FAILED_REPORT_SEND_REMAINS);
});
