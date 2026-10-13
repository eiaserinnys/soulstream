import { act, renderHook } from '@testing-library/react-native';
import { usePersistentReportSend, FAILED_REPORT_SEND_REMAINS } from '../usePersistentReportSend';
import { reportReviewEntries } from '../../../component-review/persistent-report-fixtures';
import { useChatStore, createOptimisticUserEvent } from '../../../store/chatStore';
import type { PersistentReportEntry } from '../../../api/types';
import type { ApiClient } from '../../../api/client';

const entry = reportReviewEntries[1];
const base = [entry];
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => useChatStore.setState({ pendingOptimisticBySession: {} }));
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
