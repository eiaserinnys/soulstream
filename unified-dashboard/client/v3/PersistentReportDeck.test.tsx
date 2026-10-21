/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PersistentReportProvider } from '@seosoyoung/soul-ui/components/persistent-report/PersistentReportProvider';
import { InternalLinkProvider } from '@seosoyoung/soul-ui/components/InternalLinkProvider';
import { PersistentReportDeck } from './PersistentReportDeck';
import { useDashboardStore, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import type { CardRow } from '@seosoyoung/soul-ui/cards/card-types';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@seosoyoung/soul-ui/cards/card-api', async importOriginal => ({ ...await importOriginal<object>(), cardRequest: request }));
const cardRow: CardRow = { id: '0ef7a7b5-588f-436b-839b-53131aba0a43', number: 270, folderId: 'folder', title: '카드', request: '', brief: '', attachments: [], status: 'running', blockedKind: null, blockedDetail: null, positionKey: 'a', queuePositionKey: null, assigneeKind: null, assigneeAgentId: null, assigneeUserId: null, assigneeSessionId: null, nodeId: null, modelPreset: null, version: 1, archived: false, createdAt: '', updatedAt: '' };

vi.mock('@seosoyoung/soul-ui/components/LiquidGlassProvider', () => ({ useGlassSurface: () => false }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const one: PersistentReportEntry = { key: 'one', kind: 'ask', title: '확인', card_numbers: [270], context: '맥락', action: '[출처](https://example.test/)', options: ['응'], state: 'open', answer: '', updated_at: 'first' };
const two = { ...one, key: 'two', kind: 'see' as const, options: [], title: '볼 장' };
const emptyAsk = { ...one, key: 'empty-ask', options: [] };
const serverCardEntry: PersistentReportEntry & { card_id: string; card_status: 'running' } = {
  ...two, key: `card_${cardRow.id}`, card_numbers: [], card_id: cardRow.id, card_status: 'running',
};
const serverQuestionEntry: PersistentReportEntry & { card_id: string; card_status: 'blocked'; question_id: string } = {
  ...serverCardEntry, key: 'cq_question-id', kind: 'ask', options: [], card_status: 'blocked', question_id: 'question-id',
};
let root: Root; let host: HTMLDivElement;
const transport = vi.fn().mockResolvedValue({ ok: true, delivered: true, reason: null, consumeWhen: null }); const notify = vi.fn(); const focusInput = vi.fn(); const openTarget = vi.fn();
let entries: PersistentReportEntry[];
let cardTransition: ((cardId: string, status: 'done' | 'review') => Promise<void>) | undefined;
let portalTarget: HTMLDivElement | null = null;
let inlineMaxHeight: number | null = null;
const dismiss = vi.fn(async (key: string) => { entries = entries.filter(entry => entry.key !== key); await render(); });
const render = () => act(async () => root.render(<InternalLinkProvider internalOrigins={['https://example.test']} openTarget={openTarget}><PersistentReportProvider sessionId="a" entries={entries}>
  <PersistentReportDeck sessionId="a" notify={notify} transport={transport} focusInput={focusInput} dismissReport={dismiss}
    cardTransition={cardTransition}
    renderCardDetails={entry => <div data-testid={`card-details-${entry.key}`}>운영 카드 칸</div>}
    renderCardStatus={entry => <span data-testid={`card-status-${entry.key}`}>{entry.key.startsWith('cq_') ? '질문' : '카드 상태'}</span>}
    seat={portalTarget ? { target: portalTarget, body: { left: 0, top: 300, width: 152, height: 228 }, layout: { left: 0, bottom: 284, width: 342, maxHeight: 250, tailLeft: 228, tailDirection: 'left' } } : inlineMaxHeight === null ? undefined : { target: null, body: null, layout: null, inlineMaxHeight }} />
</PersistentReportProvider></InternalLinkProvider>));
const button = (name: string) => Array.from(host.querySelectorAll('button')).find(node => (node.getAttribute('aria-label') ?? node.textContent) === name)!;
let contentHeight = 0;
beforeEach(async () => {
  vi.clearAllMocks(); cardTransition = undefined; contentHeight = 100; portalTarget = null; inlineMaxHeight = null; useDashboardStore.getState().setPendingChatSend('a', null); request.mockReset(); useCardStore.getState().reset(); useCardStore.getState().putCards([cardRow]); entries = [one, two];
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const expanded = this.classList.contains('pas-report-content') && Boolean(this.querySelector('.pas-report-expand[aria-expanded="true"]'));
    return { height: this.classList.contains('pas-report-content') ? contentHeight + (expanded ? 300 : 0) : this.classList.contains('pas-report-footer') ? 32 : 0 } as DOMRect;
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function(this: HTMLElement, opts: ScrollToOptions) { this.scrollLeft = opts.left ?? 0; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); await render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(document, 'fonts'); Reflect.deleteProperty(window, 'matchMedia'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('renders only the current sheet into the accessible/tab surface, navigates by arrows and sends directly', async () => {
  expect(host.querySelector('[data-testid="report-sheet-two"]')?.getAttribute('aria-hidden')).toBe('true');
  await act(async () => button('응').click());
  expect(host.querySelector('button')?.textContent).not.toContain('확인했어');
  expect(transport).toHaveBeenCalledWith(expect.objectContaining({ sessionKey: 'a', text: '확인: 응' }));
  expect(host.querySelector('.pas-report-kind')).toBeNull();
  expect(host.querySelector('[data-current="true"]')?.getAttribute('aria-label')).toContain('답 받음');
  expect(host.querySelector('.pas-report-footer')).not.toBeNull();
  expect(host.querySelector('.pas-report-heading-main')?.firstElementChild?.tagName).toBe('H2');
  const track = host.querySelector<HTMLElement>('[data-testid="report-track"]')!;
  track.focus();
  await act(async () => track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(host.querySelector('[data-testid="report-sheet-one"]')?.hasAttribute('inert')).toBe(true);
  expect(host.querySelector('[data-testid="report-sheet-two"]')?.getAttribute('aria-hidden')).toBe('false');
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('2 / 2');
  expect(button('다음 장').disabled).toBe(true);
});
it.each([two, emptyAsk])('acknowledges and closes a %s report with closed-only context', async entry => {
  entries = [entry]; await render();
  expect(button('확인했어')).toBeTruthy();
  await act(async () => button('확인했어').click());
  expect(transport).toHaveBeenCalledWith({ sessionKey: 'a', text: `${entry.title}: 확인했어`, contextItems: [
    { key: 'persistent_report_closed', content: { key: entry.key, title: entry.title } },
  ] });
  expect(dismiss).toHaveBeenCalledWith(entry.key);
});
it('expands a server card by its card_id when the title has no number', async () => {
  entries = [serverCardEntry]; await render();
  const title = button(serverCardEntry.title);
  expect(title.getAttribute('aria-expanded')).toBe('false');
  await act(async () => title.click());
  expect(host.querySelector(`[data-testid="card-details-${serverCardEntry.key}"]`)?.textContent).toBe('운영 카드 칸');
  expect(host.querySelector(`[data-testid="card-status-${serverCardEntry.key}"]`)?.textContent).toBe('카드 상태');
});

it('toggles an expandable report from its window control', async () => {
  entries = [serverCardEntry]; await render();

  const expand = button('확대');
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  await act(async () => expand.click());
  expect(button('축소').getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector(`[data-testid="card-details-${serverCardEntry.key}"]`)).not.toBeNull();

  await act(async () => button('축소').click());
  expect(button('확대').getAttribute('aria-expanded')).toBe('false');
  expect(host.querySelector(`[data-testid="card-details-${serverCardEntry.key}"]`)).toBeNull();
});

it('does not show a window control for a report without expandable card details', async () => {
  entries = [{ ...two, key: 'plain-report', card_numbers: [] }]; await render();

  expect(host.querySelector('.pas-report-heading')?.textContent).toContain('볼 장');
  expect(host.querySelector('.pas-report-title button')).toBeNull();
  expect(host.querySelector('.pas-report-heading[data-window]')).toBeNull();
  expect(host.querySelector('.pas-report-window')).toBeNull();
});

it('completes a review card without dismissing it directly and exposes the undo transition', async () => {
  const review = { ...serverCardEntry, card_status: 'review', card_numbers: [270] };
  entries = [review]; cardTransition = vi.fn(async () => {}); await render();
  expect(button('완료')).toBeTruthy();
  button('완료').focus();
  await act(async () => button('완료').click());
  expect(cardTransition).toHaveBeenCalledTimes(1); expect(cardTransition).toHaveBeenCalledWith(cardRow.id, 'done');
  expect(dismiss).not.toHaveBeenCalled();
  expect(host.textContent).toContain('#270 완료됨');

  entries = []; await render();
  expect(host.querySelector('.pas-report-sheet[data-undo-only]')).not.toBeNull();
  expect(host.querySelector('.pas-report-undo')?.textContent).toContain('되돌리기');
  expect(host.querySelector('.pas-report-undo .pas-undo-ring[aria-hidden="true"]')).not.toBeNull();
  expect(focusInput).toHaveBeenCalled();
  await act(async () => button('되돌리기').click());
  expect(cardTransition).toHaveBeenLastCalledWith(cardRow.id, 'review');
  expect(host.querySelector('.pas-report-undo')).toBeNull();
});

it('keeps completion available for a review card even with an existing answer', async () => {
  entries = [{ ...serverCardEntry, kind: 'ask', card_status: 'review', state: 'answered', answer: '확인 완료', options: [] }];
  contentHeight = 500; inlineMaxHeight = 250; await render();
  expect(host.querySelector('[data-testid="report-deck"]')?.getAttribute('data-overflow')).toBe('true');
  expect(button('완료')).toBeTruthy();
});

it('keeps the existing acknowledgement on a blocked card', async () => {
  const blocked = { ...serverCardEntry, card_status: 'blocked' };
  entries = [blocked]; await render();
  expect(button('완료')).toBeUndefined();
  await act(async () => button('확인했어').click());
  expect(dismiss).toHaveBeenCalledWith(blocked.key);
  expect(cardTransition).toBeUndefined();
});

it('keeps inline report height within its measured chat column and scrolls the reading area', async () => {
  entries = [serverCardEntry]; contentHeight = 500; inlineMaxHeight = 250;
  await render();
  const deck = host.querySelector<HTMLElement>('[data-testid="report-deck"]')!;
  expect(deck.dataset.inlineMaxHeight).toBe('true');
  expect(deck.style.getPropertyValue('--pas-report-inline-max-height')).toBe('250px');
  expect(deck.dataset.overflow).toBe('true');
  expect(host.querySelector('.pas-report-reading')).not.toBeNull();
});

it('keeps answered height separate for expanded and collapsed states', async () => {
  const answerable = { ...serverQuestionEntry, title: '응답 가능한 카드', options: ['응'] };
  entries = [answerable]; await render();
  const deck = host.querySelector<HTMLElement>('[data-testid="report-deck"]')!;
  const collapsedHeight = deck.style.height;
  await act(async () => button('응답 가능한 카드').click());
  const expandedHeight = deck.style.height;
  expect(expandedHeight).not.toBe(collapsedHeight);
  expect(JSON.parse(host.querySelector<HTMLElement>('.pas-report-sheet')!.dataset.publication!)[2]).toBe(true);
  await act(async () => button('응').click());
  await act(async () => button('응답 가능한 카드').click());
  expect(JSON.parse(host.querySelector<HTMLElement>('.pas-report-sheet')!.dataset.publication!)[2]).toBe(false);
  expect(deck.style.height).toBe(collapsedHeight);
});

it('collapses the open card when pagination changes the current report', async () => {
  entries = [{ ...serverCardEntry, title: '운영 카드' }, { ...two, key: 'next-report', title: '다음 보고' }];
  await render();
  await act(async () => button('운영 카드').click());
  expect(host.querySelector(`[data-testid="card-details-${serverCardEntry.key}"]`)).not.toBeNull();
  await act(async () => button('다음 장').click());
  expect(host.querySelector('[data-current="true"]')?.getAttribute('aria-label')).toContain('다음 보고');
  expect(host.querySelector(`[data-testid="card-details-${serverCardEntry.key}"]`)).toBeNull();
});
it.each([['card', serverCardEntry], ['open question', serverQuestionEntry]])('acknowledges a server %s by deleting it without sending a PAS intervention', async (_label, entry) => {
  entries = [entry]; await render();
  await act(async () => button('확인했어').click());
  expect(dismiss).toHaveBeenCalledWith(entry.key);
  expect(transport).not.toHaveBeenCalled();
});
it('does not show the acknowledgement for an answered ask or close when a send is retained', async () => {
  const answered = { ...one, state: 'answered' as const, answer: '응' };
  entries = [answered]; await render();
  expect(host.textContent).toContain('받은 답');
  expect(host.textContent).not.toContain('확인했어');
  entries = [emptyAsk];
  await act(async () => useDashboardStore.getState().setPendingChatSend('a', { id: 'other', status: 'failed', text: '실패', messageText: '실패', mode: 'intervention', attachments: [], attachmentPaths: [] }));
  await render();
  await act(async () => button('확인했어').click());
  expect(dismiss).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith('보내지 못한 글이 대화에 남아 있어. 다시 보내거나 입력창으로 옮겨 줘.');
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
it.each([{ ctrlKey: true }, { metaKey: true }, { button: 1 }])('leaves resolved-link gestures to the browser: %j', async modifiers => {
  const card = host.querySelector<HTMLAnchorElement>('[data-current="true"] a[aria-label="카드 270번 열기"]')!;
  const event = new MouseEvent('button' in modifiers ? 'auxclick' : 'click', { bubbles: true, cancelable: true, ...modifiers });
  const preventDefault = vi.spyOn(event, 'preventDefault');
  await act(async () => card.dispatchEvent(event));
  expect(preventDefault).not.toHaveBeenCalled(); expect(event.defaultPrevented).toBe(false);
  expect(request).not.toHaveBeenCalled(); expect(openTarget).not.toHaveBeenCalled();
  expect(card.getAttribute('href')).toBe(`/?card=${cardRow.id}`); expect(card.target).toBe('_blank');
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
  button('확인했어').focus();
  await act(async () => button('확인했어').click());
  expect(dismiss).toHaveBeenCalledWith('two'); expect(focusInput).toHaveBeenCalledOnce();
  expect(host.querySelector('[data-testid="report-deck"]')).toBeNull(); outside.remove();
});
it('preserves the viewed key when a preceding sheet disappears and focuses the next sheet when the focused one disappears', async () => {
  await act(async () => button('다음 장').click()); button('확인했어').focus();
  entries = [two, { ...one, key: 'three' }]; await render();
  expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('1 / 2');
  entries = [entries[1]]; await render();
  expect(document.activeElement?.getAttribute('data-testid')).toBe('report-sheet-three');
});

it.each([false, true])('keeps composer focus after a focused control disappears, including portal=%s', async portal => {
  const outside = document.createElement('input'); document.body.append(outside);
  if (portal) { portalTarget = document.createElement('div'); document.body.append(portalTarget); await render(); }
  const deckHost = portalTarget ?? host;
  const focused = deckHost.querySelector<HTMLButtonElement>('[data-current="true"] button')!;
  focused.focus();
  // Native removal of the focused control supplies no deck blur event.
  focused.remove(); expect(document.activeElement).toBe(document.body);
  outside.focus();
  entries = [two]; await render();
  expect(document.activeElement).toBe(outside);
  outside.remove(); portalTarget?.remove();
});

it('aligns the selected second sheet after moving into and out of the portrait portal', async () => {
  await act(async () => button('다음 장').click());
  portalTarget = document.createElement('div'); document.body.append(portalTarget);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('pas-report-track') ? 340 : 0; });
  await render(); expect(portalTarget.querySelector<HTMLElement>('.pas-report-track')!.scrollLeft).toBe(340);
  const target = portalTarget; portalTarget = null; await render(); expect(host.querySelector<HTMLElement>('.pas-report-track')!.scrollLeft).toBe(340); target.remove();
});

it('settles at a page boundary without scrollend and resets a lost scroll on placement/removal', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('pas-report-track') ? 340 : 0; });
  await render(); const height = () => host.querySelector<HTMLElement>('.pas-report')!.style.height;
  expect(height()).toBe('134px');
  await act(async () => button('다음 장').click());
  contentHeight = 200; entries = entries.map(entry => ({ ...entry, context: '새 내용' })); await render(); expect(height()).toBe('134px');
  await act(async () => host.querySelector('.pas-report-track')!.dispatchEvent(new Event('scroll')));
  expect(height()).toBe('234px');
  await act(async () => button('앞 장').click());
  entries = []; await render(); entries = [one, two]; contentHeight = 300; await render(); expect(height()).toBe('334px');
});
it('retains height across the server answered revision but discards it when content is rewritten',async()=>{
 entries=[one]; await render();
 const height=()=>host.querySelector<HTMLElement>('.pas-report')!.style.height;
 expect(height()).toBe('134px');
 contentHeight=40; entries=[{...one,state:'answered',answer:'응',updated_at:'server-answered'}]; await render();
 expect(height()).toBe('134px');
 entries=[{...entries[0],context:'새 맥락',updated_at:'rewritten'}]; await render(); expect(height()).toBe('74px');
});

it('hides the whole deck with opacity until its initial font settles', async () => {
  act(() => root.unmount()); root = createRoot(host);
  let finish!: () => void;
  Object.defineProperty(document, 'fonts', { configurable: true, value: {
    check: () => false, load: () => new Promise<void>(resolve => { finish = resolve; }),
    ready: new Promise(() => {}), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } });
  await render();
  const deck = host.querySelector<HTMLElement>('[data-testid="report-deck"]')!;
  expect(deck.style.opacity).toBe('0'); expect(deck.style.visibility).toBe('');
  expect(deck.style.transitionProperty).toBe('none'); expect(deck.hasAttribute('inert')).toBe(true); expect(deck.getAttribute('aria-hidden')).toBe('true');
  await act(async () => finish());
  expect(deck.style.opacity).toBe(''); expect(deck.hasAttribute('inert')).toBe(false); expect(deck.hasAttribute('aria-hidden')).toBe(false);
});

it('omits the todo line for an unanswered sheet whose action is empty and keeps it when the action is set', async () => {
  entries = [{ ...one, key: 'no-action', action: '' }]; await render();
  expect(host.querySelector('.pas-report-content .pas-report-todo')).toBeNull();
  entries = [one]; await render();
  expect(host.querySelector('.pas-report-content .pas-report-todo')).not.toBeNull();
});
