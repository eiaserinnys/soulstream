/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderText } from '@soulstream/chat-ui';
import { InternalLinkProvider } from '../InternalLinkProvider';
import { ChatUiMessage } from './ChatUiMessage';
import { ChatUiControllerProvider, useChatUiHost } from './ChatUiControllerProvider';
import { documentFixture, envelope, fixture } from './chat-ui.test-fixture';

const fail = vi.hoisted(() => ({ render: false }));
vi.mock('./ChatUiRenderer', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ChatUiRenderer')>();
  return { ChatUiRenderer: (props: Parameters<typeof original.ChatUiRenderer>[0]) => {
    if (fail.render) throw new Error('renderer failed');
    return <original.ChatUiRenderer {...props} />;
  } };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lacks PointerEvent; Base UI checks its constructor even for a keyboard click.
class TestPointerEvent extends MouseEvent {}
globalThis.PointerEvent = TestPointerEvent as typeof PointerEvent;

describe('ChatUiMessage', () => {
  let root: Root;
  let host: HTMLDivElement;
  afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); fail.render = false; vi.restoreAllMocks(); });
  async function mount(ui: unknown = envelope, content = '저장된 글') {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<ChatUiControllerProvider sessionId="session-a"><ChatUiMessage ui={ui} content={content} /></ChatUiControllerProvider>));
  }
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === label || b.querySelector('span')?.textContent === label)!;
    expect(button).toBeTruthy(); await act(async () => button.click());
  };
  it('keeps the ordinary Markdown path when ui is absent', async () => {
    await mount(undefined); // mount default is overridden explicitly below
    await act(async () => root.render(<ChatUiMessage content="**기존 글**" />));
    expect(host.querySelector('strong')?.textContent).toBe('기존 글');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it('renders valid ui directly with all ten nodes and five field types', async () => {
    await mount();
    expect(host.querySelector('h3')?.textContent).toBe('조건');
    expect(host.querySelector('input[type="number"]')?.getAttribute('value')).toBe('8');
    expect(host.querySelector('input[type="text"]')).toBeTruthy();
    expect(host.querySelector('[data-slot="select-trigger"]')).toBeTruthy();
    expect(host.querySelectorAll('[data-slot="checkbox"]')).toHaveLength(4);
    expect(host.querySelector('fieldset legend')?.textContent).toBe('확인할 것');
    expect(host.querySelector('input[type="range"]')).toBeTruthy();
    expect(host.querySelector('form')).toBeTruthy();
    expect(host.textContent).not.toContain('저장된 글');
    await click('12명으로'); expect(host.querySelector('strong')?.textContent).toBe('12명');
  });
  it('uses default renderText for an unknown envelope version', async () => {
    await mount({ ...envelope, schema_version: 2 });
    expect(host.textContent).toContain('이 버전에서는 기본값 글로 보여줄게.');
    expect(host.textContent).toContain('8명');
    expect(host.querySelector('a')?.href).toBe('https://example.com/source');
    expect(host.querySelector('input')).toBeNull();
  });
  it.each([{ ...envelope, document: {} }, { ...envelope, document: undefined }, null])('uses saved content for an unreadable document %j', async ui => {
    await mount(ui);
    expect(host.textContent).toBe('화면을 표시하지 못했어. 저장된 글로 보여줄게.저장된 글');
  });
  it('keeps the heading margin when the fallback body follows the meta line', async () => {
    await mount({ ...envelope, document: {} }, '# 제목\n\n본문입니다.');
    const fallback = host.querySelector('.chat-ui-fallback')!;
    const meta = fallback.querySelector('.chat-ui-meta')!;
    const heading = fallback.querySelector('h1')!;
    // 카드 #1342: 메타 줄이 먼저 서므로 제목은 첫 자식이 아니다. first:mt-0이
    // 아니라 main과 같은 mt-3(12px)가 적용된다.
    expect(fallback.firstElementChild).toBe(meta);
    expect(heading.matches(':first-child')).toBe(false);
    expect(heading.classList.contains('mt-3')).toBe(true);
    expect(heading.hasAttribute('data-markdown-block')).toBe(true);
  });
  it('isolates render errors, keeps default text after changing fields, and recovers for a new publication', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount(); await click('12명으로'); fail.render = true;
    await act(async () => root.render(<ChatUiControllerProvider sessionId="session-a"><ChatUiMessage ui={envelope} content="저장된 글" /></ChatUiControllerProvider>));
    expect(host.textContent).toContain('화면을 표시하지 못했어. 기본값 글로 보여줄게.');
    expect(host.textContent).toContain('8명'); expect(host.textContent).not.toContain('12명');
    fail.render = false;
    await act(async () => root.render(<ChatUiControllerProvider sessionId="session-a"><ChatUiMessage ui={{ ...envelope, hash: 'b'.repeat(64) }} content="저장된 글" /></ChatUiControllerProvider>));
    expect(host.querySelector('input')).toBeTruthy();
  });
  it('evaluates visibility and expands entities without duplicating nested citations', async () => {
    await mount(); expect(host.textContent).not.toContain('할인 적용');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-slot="checkbox"]')!.click());
    expect(host.textContent).toContain('할인 적용');
    await click('자료 상세'); expect(host.textContent).toContain('상세 내용');
    expect(host.querySelectorAll('a[href="https://example.com/source"]')).toHaveLength(2); // citation + open_source
    await click('가정 보기'); expect(host.textContent).toContain('실제 요금이 아니야.');
  });
  it('copies current text only after clipboard success and reports failure', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await mount();
    function Notice() { return <output>{useChatUiHost().feedback}</output>; }
    await act(async () => root.render(<ChatUiControllerProvider sessionId="session-a"><ChatUiMessage ui={envelope} content="저장된 글" /><Notice /></ChatUiControllerProvider>));
    await click('12명으로'); await click('복사');
    expect(writeText).toHaveBeenCalledWith(renderText(documentFixture, { values: { ...Object.fromEntries(Object.entries(documentFixture.fields).map(([k, f]) => [k, f.initial])), seats: 12 } }));
    expect(host.querySelector('output')?.textContent).toBe('현재 값 복사됨');
    await click('자료 상세'); expect(host.querySelector('output')?.textContent).toBe('현재 값 복사됨');
    writeText.mockRejectedValueOnce(new Error('denied')); await click('복사');
    expect(host.querySelector('output')?.textContent).toBe('복사하지 못했어.');
    await click('초기화'); expect(host.querySelector('output')?.textContent).toBe('기본값으로 돌아갔어');
  });
  it('normalizes number text before composing even when submit does not blur the input', async () => {
    await mount(); const control = host.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => { control.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, '999'); control.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(control.value).toBe('999');
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(control.value).toBe('50');
  });
  it('shows an uncited entity source in one place while expanding and collapsing', async () => {
    await mount({ ...envelope, document: { ...fixture, sources: { ...fixture.sources, extra: { type: 'external_link', label: '항목 출처', url: 'https://example.com/item' } }, body: fixture.body.map(node => node.kind === 'entity' ? { ...node, source: 'extra' } : node) } });
    const links = () => host.querySelectorAll('a[href="https://example.com/item"]');
    expect(links()).toHaveLength(1);
    await click('자료 상세'); expect(links()).toHaveLength(1);
    expect(links()[0].closest('[data-chat-ui-node="entity"]')).toBeTruthy();
    await click('자료 상세'); expect(links()).toHaveLength(1);
    expect(links()[0].closest('[data-chat-ui-node="entity"]')).toBeNull();
  });
  it('keeps the assumption action mounted in its button row and expands the note below', async () => {
    const action = fixture.body.find(node => node.id === 'assumption')!;
    await mount({ ...envelope, document: { ...fixture, body: [{ id: 'actions', kind: 'group', layout: 'wrap', children: [action] }] } });
    const button = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '가정 보기')!;
    const row = button.closest('.chat-ui-group')!;
    await click('가정 보기');
    expect(button.isConnected).toBe(true); expect(button.closest('.chat-ui-group')).toBe(row);
    const note = row.querySelector('.chat-ui-action-note')!;
    expect(note.textContent).toBe('실제 요금이 아니야.');
    expect(note.parentElement).toBe(row); expect(button.getAttribute('aria-controls')).toBe(note.id);
    expect(row.lastElementChild).toBe(note);
  });
  it('uses the same Button classes for source actions and keeps the shared internal-link and modifier path', async () => {
    await mount(); const openTarget = vi.fn();
    const ui = { ...envelope, document: { ...fixture, sources: { ...fixture.sources, link: { type: 'external_link', label: '원문', url: 'https://example.com/?card=card-review' } } } };
    await act(async () => root.render(<InternalLinkProvider internalOrigins={['https://example.com']} openTarget={openTarget}><ChatUiControllerProvider sessionId="session-a"><ChatUiMessage ui={ui} content="저장된 글" /></ChatUiControllerProvider></InternalLinkProvider>));
    const link = Array.from(host.querySelectorAll('a')).find(anchor => anchor.textContent === '출처 열기')!;
    const copy = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '복사')!;
    expect(link.className).toBe(copy.className);
    expect(link.getAttribute('target')).toBe('_blank');
    let prevented = false;
    // Observe after React handles the event; suppress jsdom's unsupported navigation only afterwards.
    host.addEventListener('click', event => { prevented = event.defaultPrevented; event.preventDefault(); });
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(openTarget).toHaveBeenCalledWith({ kind: 'card', cardId: 'card-review' }, link.href, '출처 열기');
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })));
    expect(prevented).toBe(false); expect(openTarget).toHaveBeenCalledTimes(1);
  });
});

describe('보여 주기 부품', () => {
  it('표, 목록, 차트, 흐름, 그림과 격리된 HTML을 그린다', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const body = [
      { id: 'stats', kind: 'stats', tiles: [{ label: '하나', value: 1 }, { label: '둘', value: 2 }] },
      { id: 'badge', kind: 'badge', label: '진행', tone: 'good' },
      { id: 'table', kind: 'table', columns: [{ key: 'name', label: '이름' }], rows: [{ name: '사과' }] },
      { id: 'list', kind: 'list', items: [{ id: 'a', title: '링크 항목', url: 'https://example.com' }] },
      { id: 'bars', kind: 'bars', items: [{ label: '막대', value: 4 }] },
      { id: 'line', kind: 'line', series: [{ label: '값', points: [{ x: '2026-01-01T00:00:00Z', y: 1 }, { x: '2026-01-02T00:00:00Z', y: 2 }] }] },
      { id: 'steps', kind: 'steps', items: [{ title: '검증', state: 'done' }] },
      { id: 'compare', kind: 'compare', columns: [{ id: 'a', title: '가', items: [{ text: '하나' }] }, { id: 'b', title: '나', items: [{ text: '둘' }] }] },
      { id: 'flow', kind: 'flow', nodes: [{ id: 'a', title: '출발', col: 1, row: 1 }, { id: 'b', title: '도착', col: 2, row: 1 }], edges: [{ from: 'a', to: 'b' }] },
      { id: 'image', kind: 'image', attachment_id: 'att-1', alt: '그림' },
      { id: 'html', kind: 'html', html: '<p>안녕</p>', height: 120, alt: '작은 보고' },
    ];
    await act(async () => root.render(<ChatUiControllerProvider sessionId="session-a"><ChatUiMessage ui={{ ...envelope, document: { schema_version: 1, body } }} content="저장된 글" sessionId="session-a" /></ChatUiControllerProvider>));
    expect(host.querySelector('th')?.textContent).toBe('이름');
    expect(host.querySelector('td')?.textContent).toBe('사과');
    expect(host.querySelector('a[href="https://example.com"]')?.textContent).toContain('링크 항목');
    expect(host.querySelector('[data-chat-ui-node="line"] svg')).toBeTruthy();
    expect(host.querySelector('[data-chat-ui-node="flow"] svg')).toBeTruthy();
    expect(host.querySelector('[data-chat-ui-node="image"] img')?.getAttribute('src')).toContain('att-1');
    expect(host.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
    expect(host.querySelector('iframe')?.getAttribute('srcdoc')).toContain('<p>안녕</p>');
    for (const id of ['stats', 'badge', 'bars', 'steps', 'compare']) expect(host.querySelector(`[data-chat-ui-node="${id}"]`)?.textContent).toBeTruthy();
    act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();
  });
});
