/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { initialState, reduce, type FieldValue } from '@soulstream/chat-ui';
import { ChatUiField } from './ChatUiFields';
import { documentFixture } from './chat-ui.test-fixture';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestPointerEvent extends MouseEvent {}
globalThis.PointerEvent = TestPointerEvent as typeof PointerEvent;
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });
function mount(field: string) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  function FieldHarness() {
    const [state, setState] = useState(() => initialState(documentFixture));
    const set = (value: FieldValue) => setState(state => reduce(documentFixture, state, { type: 'set', field, value }));
    return <><ChatUiField field={documentFixture.fields[field]} value={state.values[field]} label="입력" onChange={set} /><output>{JSON.stringify(state.values[field])}</output></>;
  }
  act(() => root.render(<FieldHarness />));
  dispose = () => { act(() => root.unmount()); host.remove(); };
  return host;
}
function input(host: HTMLElement, value: string) {
  const control = host.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return control;
}
it('keeps an empty number buffer out of state and restores the reduced value on blur', () => {
  const host = mount('seats'); const control = input(host, '');
  expect(control.value).toBe(''); expect(host.querySelector('output')?.textContent).toBe('8');
  act(() => control.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(control.value).toBe('8'); input(host, '100');
  expect(host.querySelector('output')?.textContent).toBe('50'); expect(control.value).toBe('50');
});
it('passes text to the common reducer and selection through option ids', () => {
  const host = mount('memo'); input(host, '덧붙일 말'); expect(host.querySelector('output')?.textContent).toBe('"덧붙일 말"');
});
it('adds and removes selection values through the existing checkbox', () => {
  const host = mount('checks'); const controls = host.querySelectorAll<HTMLButtonElement>('[data-slot="checkbox"]');
  act(() => controls[1].click()); expect(host.querySelector('output')?.textContent).toBe('["focus","reset"]');
  act(() => controls[0].click()); expect(host.querySelector('output')?.textContent).toBe('["reset"]');
});
