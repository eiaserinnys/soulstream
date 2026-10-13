/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useDashboardStore } from '@seosoyoung/soul-ui';
import type { PersistentReportEntry } from '@seosoyoung/soul-ui';
import { usePersistentReportDismiss } from './usePersistentReportDismiss';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/persistent-sessions', () => ({ createPersistentSessionsApi: () => ({ dismissReport: request }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const one: PersistentReportEntry = { key: 'one', kind: 'see', title: '하나', card_numbers: [], context: '', action: '', options: [], state: 'open', answer: '', updated_at: 'first' };
const two = { ...one, key: 'two' };
let root: Root; let host: HTMLDivElement; let actions: ReturnType<typeof usePersistentReportDismiss>;
const notify = vi.fn(); const getNotify = () => notify;
function Probe() { actions = usePersistentReportDismiss('a', getNotify); return null; }
function deferred() { let resolve!: (value: unknown) => void; let reject!: (error: Error) => void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(async () => {
  vi.clearAllMocks(); useDashboardStore.getState().reset(); useDashboardStore.getState().setPersistentReport('a', [one, two]);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<Probe />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
it('clears only each request key with reversed full-board responses and deduplicates a pending key', async () => {
  const first = deferred(), second = deferred(); request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  let a!: Promise<void>, b!: Promise<void>;
  await act(async () => { a = actions.dismiss('one'); b = actions.dismiss('two'); void actions.dismiss('one'); });
  expect(request).toHaveBeenCalledTimes(2); expect(actions.pending.has('one')).toBe(true); expect(actions.pending.has('two')).toBe(true);
  await act(async () => { second.resolve({ ok: true, persistent_report: [] }); await b; });
  expect(useDashboardStore.getState().persistentReports.a).toEqual([one]); expect(actions.pending.has('one')).toBe(true); expect(actions.pending.has('two')).toBe(false);
  await act(async () => { first.resolve({ ok: true, persistent_report: [two] }); await a; });
  expect(useDashboardStore.getState().persistentReports.a).toEqual([]); expect(actions.pending.size).toBe(0); expect(notify).not.toHaveBeenCalled();
});
it('a failure retains its sheet, leaves another request pending and uses the existing feedback', async () => {
  const first = deferred(), second = deferred(); request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  let a!: Promise<void>, b!: Promise<void>;
  await act(async () => { a = actions.dismiss('one'); b = actions.dismiss('two'); });
  await act(async () => { first.reject(new Error('offline')); await a; });
  expect(useDashboardStore.getState().persistentReports.a).toEqual([one, two]); expect(actions.pending.has('one')).toBe(false); expect(actions.pending.has('two')).toBe(true);
  expect(notify).toHaveBeenCalledWith('보고를 내리지 못했어.');
  await act(async () => { second.resolve({ ok: true, persistent_report: [one] }); await b; });
  expect(useDashboardStore.getState().persistentReports.a).toEqual([one]);
});
it('a server replacement of the same key wins over an old DELETE acknowledgement', async () => {
  const first = deferred(); request.mockReturnValueOnce(first.promise); let a!: Promise<void>;
  await act(async () => { a = actions.dismiss('one'); });
  const replacement = { ...one, updated_at: 'latest' };
  await act(async () => useDashboardStore.getState().setPersistentReport('a', [replacement, two]));
  await act(async () => { first.resolve({ ok: true, persistent_report: [two] }); await a; });
  expect(useDashboardStore.getState().persistentReports.a).toEqual([replacement, two]);
});
