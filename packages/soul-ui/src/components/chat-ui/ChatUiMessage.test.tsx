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
  async function mount(ui: unknown = envelope) {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<ChatUiControllerProvider sessionId="session-a"><ChatUiMessage ui={ui} content="저장된 글" /></ChatUiControllerProvider>));
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
    expect(openTarget).toHaveBeenCalledWith({ kind: 'card', cardId: 'card-review' }, link.href);
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })));
    expect(prevented).toBe(false); expect(openTarget).toHaveBeenCalledTimes(1);
  });
});
