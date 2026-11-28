/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { initialState, validateChatUiDocument, type ChatUiDocumentV1 } from '@soulstream/chat-ui';
import { ChatUiDisplay } from './ChatUiDisplay';

function renderDisplay(body: ChatUiDocumentV1['body']) {
  const result = validateChatUiDocument({ schema_version: 1, units: { percent: { dims: {}, symbol: '%', scale: 1 } }, body });
  if (!result.ok) throw Error(JSON.stringify(result.errors));
  const doc = result.document;
  const node = doc.body[0]!;
  if (node.kind !== 'line' && node.kind !== 'compare') throw Error(node.kind);
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<ChatUiDisplay node={node} doc={doc} state={initialState(doc)} />);
  return host;
}

it('uses local times and keeps percent grids anchored at 0, 50 and 100', () => {
  const start = '2026-11-28T13:05:00+09:00';
  const end = '2026-11-28T14:05:00+09:00';
  const host = renderDisplay([{ id: 'line', kind: 'line', unit: 'percent', series: [{ label: 'CPU', points: [
    { x: start, y: 22 }, { x: end, y: 38 },
  ] }] }]);
  expect([...host.querySelectorAll('.chat-ui-chart-scale span')].map(el => el.textContent)).toEqual(['0%', '50%', '100%']);
  const labels = host.querySelectorAll('.chat-ui-chart-times span');
  const localLabel = (time: string) => {
    const date = new Date(time);
    return [date.getHours(), date.getMinutes()].map(value => String(value).padStart(2, '0')).join(':');
  };
  expect([labels[0]?.textContent, labels[2]?.textContent]).toEqual([localLabel(start), localLabel(end)]);
});

it('keeps an omitted comparison mark visually distinct from partial', () => {
  const host = renderDisplay([{ id: 'compare', kind: 'compare', columns: [
    { id: 'a', title: 'A', items: [{ text: 'Unmarked' }, { text: 'Partial', mark: 'partial' }] },
    { id: 'b', title: 'B', items: [{ text: 'Yes', mark: 'yes' }] },
  ] }]);
  expect([...host.querySelectorAll('.chat-ui-compare-item > span:first-child')].map(el => el.textContent)).toEqual(['', '−', '✓']);
});
