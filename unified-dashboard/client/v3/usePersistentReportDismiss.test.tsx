/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useDashboardStore } from '@seosoyoung/soul-ui';
import type { PersistentReportEntry } from '@seosoyoung/soul-ui';
import { PersistentReportProvider } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { ChatUiControllerProvider, ChatUiOperationsBridge, useChatUiFeedback } from '@seosoyoung/soul-ui/components/chat-ui/ChatUiControllerProvider';
import type { ChatUiOperationsHandle } from '@seosoyoung/soul-ui/components/chat-ui/chat-ui-composer';
import { PersistentReportDeck } from './PersistentReportDeck';
import { usePersistentReportDismiss } from './usePersistentReportDismiss';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/persistent-sessions', () => ({ createPersistentSessionsApi: () => ({ dismissReport: request }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const one: PersistentReportEntry = { key: 'one', kind: 'see', title: '하나', card_numbers: [], context: '', action: '', options: [], state: 'open', answer: '', updated_at: 'first' };
const two = { ...one, key: 'two' };
let root: Root; let host: HTMLDivElement; let actions: ReturnType<typeof usePersistentReportDismiss>;
const notify = vi.fn(); const clearFeedback = vi.fn(); const getNotify = () => ({ notify, clearFeedback });
function Probe() { actions = usePersistentReportDismiss('a', getNotify); return null; }
function deferred() { let resolve!: (value: unknown) => void; let reject!: (error: Error) => void; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(async () => {
  vi.clearAllMocks(); useDashboardStore.getState().reset(); useDashboardStore.getState().setPersistentReport('a', [one, two]);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root.render(<Probe />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('clears only each request key with reversed full-board responses and deduplicates a pending key', async () => {
  const first = deferred(), second = deferred(); request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  let a!: Promise<void>, b!: Promise<void>;
  await act(async () => { a = actions.dismiss('one'); b = actions.dismiss('two'); void actions.dismiss('one'); });
  expect(actions.visibleEntries).toEqual([]); expect(request).toHaveBeenCalledTimes(2); expect(actions.pending.has('one')).toBe(true); expect(actions.pending.has('two')).toBe(true);
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
  expect(useDashboardStore.getState().persistentReports.a).toEqual([one, two]); expect(actions.pending.has('one')).toBe(false); expect(actions.pending.has('two')).toBe(true); expect(actions.visibleEntries).toEqual([one]);
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

let operations: ChatUiOperationsHandle | null = null;
const registerOperations = (value: ChatUiOperationsHandle | null) => { operations = value; };
const getOperations = () => operations ?? undefined;
function Feedback() { const { feedback, open } = useChatUiFeedback(); return <p role="status" data-open={open}>{feedback}</p>; }
function Integrated() {
  actions = usePersistentReportDismiss('a', getOperations);
  return <ChatUiControllerProvider sessionId="a"><ChatUiOperationsBridge register={registerOperations} />
    <PersistentReportProvider sessionId="a" entries={actions.visibleEntries}>
      <PersistentReportDeck sessionId="a" appendGeneratedText={() => ({ ok: true })} focusInput={() => host.querySelector('textarea')!.focus()} dismissReport={actions.dismiss} />
    </PersistentReportProvider><textarea /><Feedback />
  </ChatUiControllerProvider>;
}
async function mountIntegrated() {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function(this: HTMLElement, options: ScrollToOptions) { this.scrollLeft = options.left ?? 0; } });
  await act(async () => root.render(<Integrated />));
}
const sheetKeys = () => [...host.querySelectorAll('article')].map(node => node.dataset.testid);
it('keeps the same server publication hidden through a JSON full-board update and removes it after success', async () => {
  await mountIntegrated();
  const pending = deferred(); request.mockReturnValueOnce(pending.promise);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-current="true"] button')!.click());
  const third = { ...one, key: 'third', title: '셋째' };
  const received = JSON.parse(JSON.stringify([one, two, third])) as PersistentReportEntry[];
  expect(received[0]).not.toBe(one);
  await act(async () => useDashboardStore.getState().setPersistentReport('a', received));
  expect(sheetKeys()).toEqual(['report-sheet-two', 'report-sheet-third']);
  expect(host.querySelector('.pas-report-count')?.textContent).toBe('1 / 2');
  await act(async () => pending.resolve({ ok: true, persistent_report: [two] }));
  expect(useDashboardStore.getState().persistentReports.a).toEqual(received.slice(1));
  expect(sheetKeys()).toEqual(['report-sheet-two', 'report-sheet-third']);
  expect(host.querySelector('.pas-report-count')?.textContent).toBe('1 / 2');
});
it('shows a newer publication while DELETE waits and keeps it after the old acknowledgement', async () => {
  await mountIntegrated();
  const pending = deferred(); request.mockReturnValueOnce(pending.promise);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-current="true"] button')!.click());
  const replacement = { ...one, title: '고친 하나', updated_at: 'latest' };
  await act(async () => useDashboardStore.getState().setPersistentReport('a', [replacement, two]));
  expect(sheetKeys()).toEqual(['report-sheet-one', 'report-sheet-two']);
  expect(host.querySelector('[data-testid="report-sheet-one"] h2')?.textContent).toBe('고친 하나');
  expect(host.querySelector('.pas-report-count')?.textContent).toBe('2 / 2');
  await act(async () => pending.resolve({ ok: true, persistent_report: [two] }));
  expect(useDashboardStore.getState().persistentReports.a).toEqual([replacement, two]);
  expect(sheetKeys()).toEqual(['report-sheet-one', 'report-sheet-two']);
});
it('unhides only the pending publication on failure and shows the current server board', async () => {
  await mountIntegrated();
  const pending = deferred(); request.mockReturnValueOnce(pending.promise);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-current="true"] button')!.click());
  const third = { ...one, key: 'third', title: '셋째' };
  const received = JSON.parse(JSON.stringify([one, { ...two, title: '고친 둘' }, third])) as PersistentReportEntry[];
  await act(async () => useDashboardStore.getState().setPersistentReport('a', received));
  expect(sheetKeys()).toEqual(['report-sheet-two', 'report-sheet-third']);
  await act(async () => pending.reject(new Error('offline')));
  expect(useDashboardStore.getState().persistentReports.a).toEqual(received);
  expect(sheetKeys()).toEqual(['report-sheet-one', 'report-sheet-two', 'report-sheet-third']);
  expect(host.querySelector('.pas-report-count')?.textContent).toBe('2 / 3');
  expect(host.querySelector('[data-testid="report-sheet-two"] h2')?.textContent).toBe('고친 둘');
});
it('removes delayed dismissals immediately under the real provider/deck, moves focus, and restores only a failed key in order', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function(this: HTMLElement, options: ScrollToOptions) { this.scrollLeft = options.left ?? 0; } });
  const third = { ...one, key: 'third', title: '셋째', kind: 'ask' as const };
  await act(async () => { useDashboardStore.getState().setPersistentReport('a', [one, two, third]); root.render(<Integrated />); });
  const first = deferred(), second = deferred(); request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const seen = () => host.querySelector<HTMLButtonElement>('[data-current="true"] button')!;
  seen().focus(); await act(async () => seen().click());
  expect(host.querySelector('[data-testid="report-sheet-one"]')).toBeNull();
  expect(host.querySelector('.pas-report-count')?.textContent).toBe('1 / 2');
  expect(document.activeElement?.getAttribute('data-testid')).toBe('report-sheet-two');
  seen().focus(); await act(async () => seen().click());
  expect(host.querySelector('.pas-report-nav')).toBeNull();
  expect(document.activeElement?.getAttribute('data-testid')).toBe('report-sheet-third');
  await act(async () => { first.reject(new Error('offline')); });
  expect([...host.querySelectorAll('article')].map(node => node.dataset.testid)).toEqual(['report-sheet-one', 'report-sheet-third']);
  expect(host.querySelector('[role="status"]')?.textContent).toBe('보고를 내리지 못했어.');
  await act(async () => { second.resolve({ ok: true, persistent_report: [one, third] }); });
  expect([...host.querySelectorAll('article')].map(node => node.dataset.testid)).toEqual(['report-sheet-one', 'report-sheet-third']);
  expect(host.querySelector('[role="status"]')?.textContent).toBe('');
  expect(host.querySelector('[role="status"]')?.getAttribute('data-open')).toBe('true');
  vi.unstubAllGlobals();
});
