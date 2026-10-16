/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { initialState, reduce, type FieldValue, type Field } from '@soulstream/chat-ui';
import { ChatUiField } from './ChatUiFields';
import { documentFixture } from './chat-ui.test-fixture';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class TestPointerEvent extends MouseEvent {}
globalThis.PointerEvent = TestPointerEvent as typeof PointerEvent;
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });
function mount(field: string, numberField?: Extract<Field, { type: 'number' }>, duplicate = false) {
  const doc = numberField ? { ...documentFixture, fields: { ...documentFixture.fields, [field]: numberField } } : documentFixture;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  function FieldHarness() {
    const [state, setState] = useState(() => initialState(doc));
    const set = (value: FieldValue) => { const next = reduce(doc, state, { type: 'set', field, value }); setState(next); return next.values[field]; };
    return <><ChatUiField field={doc.fields[field]} value={state.values[field]} label="입력" onChange={set} />{duplicate && <ChatUiField field={doc.fields[field]} value={state.values[field]} label="둘째 입력" onChange={set} />}<output>{JSON.stringify(state.values[field])}</output><button onClick={() => set(numberField?.initial ?? 8)}>outside</button></>;
  }
  act(() => root.render(<FieldHarness />));
  dispose = () => { act(() => root.unmount()); host.remove(); };
  return host;
}
function input(host: HTMLElement, value: string, index = 0) {
  const control = host.querySelectorAll('input')[index]!;
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
  expect(host.querySelector('output')?.textContent).toBe('50'); expect(control.value).toBe('100');
});
it.each([
  [1, 50, 1, 8, ['9', '99', '999'], [9, 50, 50], '50'],
  [2020, 2035, 1, 2020, ['2', '20', '202', '2028'], [2020, 2020, 2020, 2028], '2028'],
  [0, 100, 5, 0, ['3', '35'], [5, 35], '35'],
] as const)('retains typed digits for %s..%s step %s while calculation uses reduced values', (min, max, step, initial, texts, values, blurred) => {
  const host = mount('seats', { type: 'number', min, max, step, initial, unit: 'count' });
  let control: HTMLInputElement;
  texts.forEach((text, index) => { control = input(host, text); expect(control.value).toBe(text); expect(host.querySelector('output')?.textContent).toBe(String(values[index])); });
  act(() => control!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(control!.value).toBe(blurred);
});
it('replaces an active typing buffer when another control changes the field', () => {
  const host = mount('seats'); const control = input(host, '999');
  act(() => control.focus());
  expect(control.value).toBe('999');
  act(() => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(control.value).toBe('8');
});
it('synchronizes another number input bound to the same field without losing the writer buffer', () => {
  const host = mount('seats', undefined, true); const first = input(host, '999');
  expect(first.value).toBe('999'); expect(host.querySelectorAll('input')[1].value).toBe('50');
  act(() => first.focus()); input(host, '22', 1);
  expect(first.value).toBe('22'); expect(host.querySelectorAll('input')[1].value).toBe('22');
  input(host, '50', 1);
  expect(first.value).toBe('50');
});
it('passes text to the common reducer and selection through option ids', () => {
  const host = mount('memo'); input(host, '덧붙일 말'); expect(host.querySelector('output')?.textContent).toBe('"덧붙일 말"');
});
it('adds and removes selection values through the existing checkbox', () => {
  const host = mount('checks'); const controls = host.querySelectorAll<HTMLButtonElement>('[data-slot="checkbox"]');
  act(() => controls[1].click()); expect(host.querySelector('output')?.textContent).toBe('["focus","reset"]');
  act(() => controls[0].click()); expect(host.querySelector('output')?.textContent).toBe('["reset"]');
});
