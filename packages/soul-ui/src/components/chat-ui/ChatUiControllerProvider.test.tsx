/** @vitest-environment jsdom */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatUiControllerProvider, useChatUiController, useChatUiHost } from './ChatUiControllerProvider';
import { documentFixture } from './chat-ui.test-fixture';
import type { ChatUiComposerHandle } from './chat-ui-composer';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); });
function Row({ hash = 'hash-a' }: { hash?: string }) {
  const controller = useChatUiController('ui-a', hash, documentFixture);
  const { feedback } = useChatUiHost();
  return <><output>{controller.state.values.seats}</output><p>{feedback}</p>
    <button onClick={() => controller.set('seats', 12)}>set</button>
    <button onClick={() => controller.set('seats', 9)}>set9</button>
    <button onClick={() => controller.act({ type: 'copy' }, 'copy')}>copy</button>
    <button onClick={() => controller.act({ type: 'reset' }, 'reset')}>reset</button>
    <button onClick={() => controller.act({ type: 'compose' }, 'compose')}>compose</button>
    <button onClick={() => controller.act({ type: 'compose' }, 'form')}>form</button></>;
}
function Bridge({ handle }: { handle: ChatUiComposerHandle | null }) {
  const { registerComposer } = useChatUiHost();
  useEffect(() => { registerComposer(handle); return () => registerComposer(null); }, [handle, registerComposer]);
  return null;
}
function setup() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
const click = async (label: string) => { await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === label)!.click()); };
it('retains a publication across row remounts, separates hashes and sessions, and discards a disposed scope', async () => {
  setup();
  const render = async (sessionId: string, row = true, hash = 'hash-a') => act(async () => root.render(<ChatUiControllerProvider sessionId={sessionId}>{row && <Row hash={hash} />}</ChatUiControllerProvider>));
  await render('s1'); await click('set'); expect(host.querySelector('output')?.textContent).toBe('12');
  await render('s1', false); await render('s1'); expect(host.querySelector('output')?.textContent).toBe('12');
  await render('s1', true, 'hash-b'); expect(host.querySelector('output')?.textContent).toBe('8');
  await render('s1'); expect(host.querySelector('output')?.textContent).toBe('12');
  await render('s2'); expect(host.querySelector('output')?.textContent).toBe('8');
  await render('s1'); expect(host.querySelector('output')?.textContent).toBe('8');
});
it('clears operation feedback only when a field actually changes', async () => {
  setup(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  await act(async () => root.render(<ChatUiControllerProvider sessionId="s1"><Row /></ChatUiControllerProvider>));
  await click('set'); await click('copy'); expect(host.querySelector('p')?.textContent).toBe('현재 값 복사됨');
  await click('set'); expect(host.querySelector('p')?.textContent).toBe('현재 값 복사됨');
  await click('set9'); expect(host.querySelector('p')?.textContent).toBe('');
  await click('reset'); expect(host.querySelector('p')?.textContent).toBe('기본값으로 돌아갔어');
  await click('set9'); expect(host.querySelector('p')?.textContent).toBe('');
});
it('uses the latest bridge and current compose values, clearing feedback only on success', async () => {
  setup(); const appendGeneratedText = vi.fn().mockReturnValue({ ok: true });
  const render = async (handle: ChatUiComposerHandle | null) => act(async () => root.render(<ChatUiControllerProvider sessionId="s1"><Row /><Bridge handle={handle} /></ChatUiControllerProvider>));
  await render(null); await click('compose'); expect(host.querySelector('p')?.textContent).toBe('지금은 입력창에 더할 수 없어.');
  await render({ appendGeneratedText }); await click('set'); await click('compose');
  expect(appendGeneratedText).toHaveBeenLastCalledWith('s1', '질문: 12명'); expect(host.querySelector('p')?.textContent).toBe('');
  await click('form'); expect(appendGeneratedText.mock.lastCall?.[1]).toContain('인원수 입력: 12명');
  appendGeneratedText.mockReturnValue({ ok: false, reason: 'sending' }); await click('compose'); expect(host.querySelector('p')?.textContent).toBe('지금은 입력창에 더할 수 없어.');
  await render(null); await click('compose'); expect(appendGeneratedText).toHaveBeenCalledTimes(3);
});
