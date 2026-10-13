/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PersistentReportProvider } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { InternalLinkProvider } from '@seosoyoung/soul-ui/components/InternalLinkProvider';
import { PersistentReportDeck } from './PersistentReportDeck';
import type { PersistentReportEntry } from '@seosoyoung/soul-ui';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import type { CardRow } from '@seosoyoung/soul-ui/cards/card-types';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@seosoyoung/soul-ui/cards/card-api', async importOriginal => ({ ...await importOriginal<object>(), cardRequest: request }));
const cardRow: CardRow = { id: '0ef7a7b5-588f-436b-839b-53131aba0a43', number: 270, folderId: 'folder', title: '카드', request: '', brief: '', attachments: [], status: 'running', blockedKind: null, blockedDetail: null, positionKey: 'a', queuePositionKey: null, assigneeKind: null, assigneeAgentId: null, assigneeUserId: null, assigneeSessionId: null, nodeId: null, modelPreset: null, version: 1, archived: false, createdAt: '', updatedAt: '' };

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
  vi.clearAllMocks(); request.mockReset(); useCardStore.getState().reset(); useCardStore.getState().putCards([cardRow]); entries = [one, two];
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
  await act(async () => useCardStore.getState().putCards([cardRow]));
  const card = host.querySelector<HTMLAnchorElement>('a[aria-label="카드 270번 열기"]')!;
  expect(card.getAttribute('href')).toBe(`/?card=${cardRow.id}`);
  await act(async () => card.click());
  expect(openTarget).toHaveBeenCalledWith({ kind: 'card', cardId: cardRow.id }, `/?card=${cardRow.id}`);
  expect(request).not.toHaveBeenCalled();
  const source = host.querySelector<HTMLAnchorElement>('a[href="https://example.test/"]')!;
  expect(source.target).toBe('_blank'); expect(source.rel).toContain('noopener');
});
it('resolves a missing number once across sheets, then opens its ID through SourceLink', async () => {
  let resolve!: (value: unknown) => void;
  request.mockReturnValue(new Promise(yes => { resolve = yes; }));
  await act(async () => useCardStore.getState().reset());
  const card = host.querySelector<HTMLAnchorElement>('[data-current="true"] a[aria-label="카드 270번 열기"]')!;
  expect(card.getAttribute('href')).toBeNull(); expect(card.getAttribute('role')).toBe('link'); expect(card.tabIndex).toBe(0);
  await act(async () => { card.click(); card.click(); host.querySelector<HTMLAnchorElement>('[data-testid="report-sheet-two"] a')!.click(); });
  expect(request).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledWith('/api/cards?includeCompleted=true');
  expect(openTarget).not.toHaveBeenCalled();
  await act(async () => { resolve({ cards: [cardRow] }); });
  expect(openTarget).toHaveBeenCalledTimes(1);
  expect(openTarget).toHaveBeenCalledWith({ kind: 'card', cardId: cardRow.id }, `/?card=${cardRow.id}`);
  expect(card.getAttribute('href')).toBe(`/?card=${cardRow.id}`);
  expect(host.querySelector('a[href="/?card=270"]')).toBeNull();
});
it('supports Enter before lookup and preserves newer stored card versions', async () => {
  let resolve!: (value: unknown) => void; request.mockReturnValue(new Promise(yes => { resolve = yes; }));
  await act(async () => useCardStore.getState().reset());
  const card = host.querySelector<HTMLAnchorElement>('[data-current="true"] a[aria-label="카드 270번 열기"]')!;
  card.focus();
  await act(async () => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { useCardStore.getState().putCards([{ ...cardRow, version: 2, title: '새 카드' }]); resolve({ cards: [cardRow] }); });
  expect(useCardStore.getState().byId[cardRow.id].version).toBe(2);
  expect(openTarget).toHaveBeenCalledWith({ kind: 'card', cardId: cardRow.id }, `/?card=${cardRow.id}`);
});
it.each(['missing', 'failed'])('opens nothing and adds no error surface when lookup is %s', async failure => {
  if (failure === 'missing') request.mockResolvedValue({ cards: [] }); else request.mockRejectedValue(new Error('offline'));
  await act(async () => useCardStore.getState().reset());
  const card = host.querySelector<HTMLAnchorElement>('[data-current="true"] a[aria-label="카드 270번 열기"]')!;
  const before = host.textContent;
  await act(async () => card.click());
  expect(openTarget).not.toHaveBeenCalled(); expect(card.getAttribute('href')).toBeNull(); expect(host.textContent).toBe(before);
  expect(useCardStore.getState().errors).toEqual({});
});
it('prefetches unknown numbers once and remembers absent numbers until the number set changes', async () => {
  let resolve!: (value: unknown) => void; request.mockReturnValueOnce(new Promise(yes => { resolve = yes; })).mockResolvedValue({ cards: [] });
  entries = [one, { ...two, card_numbers: [328] }];
  await act(async () => { useCardStore.getState().reset(); });
  await render();
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ cards: [cardRow] }));
  expect(host.querySelector('a[aria-label="카드 270번 열기"]')?.getAttribute('href')).toBe(`/?card=${cardRow.id}`);
  expect(host.querySelector('a[aria-label="카드 328번 열기"]')?.getAttribute('href')).toBeNull();
  expect(openTarget).not.toHaveBeenCalled();
  entries = entries.map(entry => ({ ...entry })); await render();
  await act(async () => useCardStore.getState().putCards([{ ...cardRow, version: 2 }]));
  expect(request).toHaveBeenCalledTimes(1);
  entries = [one, { ...two, card_numbers: [329] }]; await render();
  expect(request).toHaveBeenCalledTimes(2);
});
it.each([
  { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 },
])('only resolves an unknown link for a modified or auxiliary click: %j', async modifiers => {
  let resolve!: (value: unknown) => void; request.mockReturnValue(new Promise(yes => { resolve = yes; }));
  await act(async () => useCardStore.getState().reset());
  expect(request).toHaveBeenCalledTimes(1);
  const card = host.querySelector<HTMLAnchorElement>('[data-current="true"] a[aria-label="카드 270번 열기"]')!;
  await act(async () => card.dispatchEvent(new MouseEvent('button' in modifiers ? 'auxclick' : 'click', { bubbles: true, cancelable: true, ...modifiers })));
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ cards: [cardRow] }));
  expect(openTarget).not.toHaveBeenCalled();
  expect(card.getAttribute('href')).toBe(`/?card=${cardRow.id}`);
});
it('allows an explicit retry after prefetch fails, without treating the number as absent', async () => {
  request.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ cards: [cardRow] });
  await act(async () => useCardStore.getState().reset());
  expect(request).toHaveBeenCalledTimes(1);
  const card = host.querySelector<HTMLAnchorElement>('[data-current="true"] a[aria-label="카드 270번 열기"]')!;
  await act(async () => card.click());
  expect(request).toHaveBeenCalledTimes(2);
  expect(openTarget).toHaveBeenCalledWith({ kind: 'card', cardId: cardRow.id }, `/?card=${cardRow.id}`);
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
