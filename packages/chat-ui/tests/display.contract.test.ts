import { describe, expect, it } from 'vitest';
import { renderText, validateChatUiDocument } from '../src/index.js';

const nodes = [
  { id: 'stats', kind: 'stats', tiles: [{ label: '하나', value: 1 }, { label: '둘', value: 2 }] },
  { id: 'badge', kind: 'badge', label: '진행', tone: 'good' },
  { id: 'table', kind: 'table', columns: [{ key: 'name', label: '이름' }, { key: 'amount', label: '수량', type: 'number' }], rows: [{ name: '사과', amount: 3 }] },
  { id: 'list', kind: 'list', items: [{ id: 'a', title: '항목', badge: { label: '진행', tone: 'good' }, value: 3, url: 'https://example.com' }] },
  { id: 'bars', kind: 'bars', items: [{ label: '막대', value: 4 }] },
  { id: 'line', kind: 'line', series: [{ label: '온도', points: [{ x: '2026-01-01T00:00:00Z', y: 1 }, { x: '2026-01-02T00:00:00Z', y: 2 }] }] },
  { id: 'steps', kind: 'steps', items: [{ title: '검증', state: 'done' }] },
  { id: 'compare', kind: 'compare', columns: [{ id: 'a', title: '가', items: [{ text: '하나' }] }, { id: 'b', title: '나', items: [{ text: '둘' }] }] },
  { id: 'flow', kind: 'flow', nodes: [{ id: 'a', title: '가', col: 1, row: 1 }, { id: 'b', title: '나', col: 2, row: 1 }], edges: [{ from: 'a', to: 'b' }] },
  { id: 'image', kind: 'image', attachment_id: 'att-1', alt: '그림' },
  { id: 'html', kind: 'html', html: '<p>안녕</p>', height: 120, alt: '작은 보고' },
];
const document = (body: unknown[]) => ({ schema_version: 1, units: { count: { dims: {}, symbol: '개', scale: 1 } }, body });

describe('보여 주기 계약', () => {
  it.each(nodes)('$kind 부품이 유효하다', node => {
    expect(validateChatUiDocument(document([node]))).toMatchObject({ ok: true });
  });
  it.each([
    [{ id: 'x', kind: 'stats', tiles: [{ label: 'a', value: '글', unit: 'count' }, { label: 'b', value: 2 }] }, 'body[0].tiles[0].unit'],
    [{ id: 'x', kind: 'list', items: [{ id: 'a', title: 'a', url: 'http://example.com' }] }, 'body[0].items[0].url'],
    [{ id: 'x', kind: 'flow', nodes: [{ id: 'a', title: 'a', col: 1, row: 1 }, { id: 'b', title: 'b', col: 1, row: 1 }], edges: [] }, 'body[0].nodes[1]'],
    [{ id: 'x', kind: 'flow', nodes: [{ id: 'a', title: 'a', col: 1, row: 1 }], edges: [{ from: 'a', to: 'b' }] }, 'body[0].edges[0].to'],
    [{ id: 'x', kind: 'html', html: '', height: 79, alt: 'alt' }, 'body[0].height'],
    [{ id: 'x', kind: 'stats', tiles: [{ label: 'a', value: 1 }] }, 'body[0].tiles'],
    [{ id: 'x', kind: 'stats', tiles: Array.from({ length: 5 }, () => ({ label: 'a', value: 1 })) }, 'body[0].tiles'],
    [{ id: 'x', kind: 'table', columns: [{ key: 'a', label: 'a' }], rows: [{ b: '값' }] }, 'body[0].rows[0].b'],
  ])('잘못된 부품의 위치를 반환한다', (node, path) => {
    const result = validateChatUiDocument(document([node]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map(issue => issue.path)).toContain(path);
  });
  it('표와 목록과 단계와 흐름을 읽을 수 있는 글로 바꾼다', () => {
    const result = validateChatUiDocument(document(nodes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = renderText(result.document);
    for (const expected of ['이름', '사과', '3', '항목', '검증', '가 → 나']) expect(text).toContain(expected);
  });
});
