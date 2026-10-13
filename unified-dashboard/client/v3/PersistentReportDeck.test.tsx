/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PersistentReportProvider } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { InternalLinkProvider } from '@seosoyoung/soul-ui/components/InternalLinkProvider';
import { PersistentReportDeck } from './PersistentReportDeck';
import type { PersistentReportEntry } from '@seosoyoung/soul-ui';

vi.mock('@seosoyoung/soul-ui/components/LiquidGlassProvider', () => ({ useGlassSurface: () => false }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const one: PersistentReportEntry = { key: 'one', kind: 'ask', title: '확인', card_numbers: [270], context: '맥락', action: '[출처](https://example.test/)', options: ['응'], state: 'open', answer: '', updated_at: 'first' };
const two = { ...one, key: 'two', kind: 'see' as const, options: [], title: '볼 장' };
let root: Root; let host: HTMLDivElement;
const append = vi.fn().mockReturnValue({ ok: true }); const focusInput = vi.fn(); const openTarget = vi.fn();
let entries: PersistentReportEntry[];
const dismiss = vi.fn(async (key: string) => { entries = entries.filter(entry => entry.key !== key); await render(); });
const render = () => act(async () => root.render(<InternalLinkProvider internalOrigins={['https://example.test']} openTarget={openTarget}><PersistentReportProvider sessionId="a" entries={entries}>
  <PersistentReportDeck sessionId="a" appendGeneratedText={append} focusInput={focusInput} dismissReport={dismiss} />
</PersistentReportProvider></InternalLinkProvider>));
const button = (name: string) => Array.from(host.querySelectorAll('button')).find(node => (node.getAttribute('aria-label') ?? node.textContent) === name)!;
beforeEach(async () => {
  vi.clearAllMocks(); entries = [one, two];
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function(this: HTMLElement, opts: ScrollToOptions) { this.scrollLeft = opts.left ?? 0; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); await render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('renders only the current sheet into the accessible/tab surface, navigates by arrows and appends without sending', async () => {
  expect(host.querySelector('[data-testid="report-sheet-two"]')?.getAttribute('aria-hidden')).toBe('true');
  await act(async () => button('응').click());
  expect(append).toHaveBeenCalledWith('a', '확인: 응');
  const track = host.querySelector<HTMLElement>('[data-testid="report-track"]')!;
  track.focus();
  await act(async () => track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(host.querySelector('[data-testid="report-sheet-one"]')?.hasAttribute('inert')).toBe(true);
  expect(host.querySelector('[data-testid="report-sheet-two"]')?.getAttribute('aria-hidden')).toBe('false');
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('2 / 2');
  expect(button('다음 장').disabled).toBe(true);
});
it('uses the existing internal-card link opener and https source policy', async () => {
  const card = host.querySelector<HTMLAnchorElement>('a[href="/?card=270"]')!;
  await act(async () => card.click());
  expect(openTarget).toHaveBeenCalledWith({ kind: 'card', cardId: '270' }, '/?card=270');
  const source = host.querySelector<HTMLAnchorElement>('a[href="https://example.test/"]')!;
  expect(source.target).toBe('_blank'); expect(source.rel).toContain('noopener');
});
it('keeps an outside focus, moves an inside focus to the replacement, then to the input when the last sheet leaves', async () => {
  const outside = document.createElement('input'); document.body.append(outside); outside.focus();
  entries = [two]; await render(); expect(document.activeElement).toBe(outside);
  expect(host.querySelector('.pas-report-nav')).toBeNull();
  button('봤다').focus();
  await act(async () => button('봤다').click());
  expect(dismiss).toHaveBeenCalledWith('two'); expect(focusInput).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-testid="report-deck"]')).toBeNull(); outside.remove();
});
it('preserves the viewed key when a preceding sheet disappears and focuses the next sheet when the focused one disappears', async () => {
  await act(async () => button('다음 장').click()); button('봤다').focus();
  entries = [two, { ...one, key: 'three' }]; await render();
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('1 / 2');
  entries = [entries[1]]; await render();
  expect(document.activeElement?.getAttribute('data-testid')).toBe('report-sheet-three');
});
