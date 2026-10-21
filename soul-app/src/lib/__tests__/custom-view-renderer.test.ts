import { cardFixture } from '../../test-support/cards';
import type { FolderSnapshot } from '../../api/cardTypes';
import type { Session } from '../../api/types';
import { buildCustomViewBindings, renderCustomViewHtml, renderDocumentHtml } from '../custom-view-renderer';

test('card/folder/session soul-bind를 안전하게 치환한다', () => {
  const snapshot = {
    folder: { id: 'folder-1', name: '업무', sortOrder: 0, parentFolderId: null, projectPageId: null, settings: {}, archived: false, status: 'open', version: 1 },
    cards: [cardFixture({ id: 'item-1', title: '<검수>', status: 'done' }), cardFixture({ id: 'cancelled', status: 'cancelled' })],
  } as FolderSnapshot;
  const sessions = {
    session: {
      agentSessionId: 'session', displayName: '세션', status: 'running', createdAt: '', updatedAt: '',
    } satisfies Session,
  };
  const bindings = buildCustomViewBindings(snapshot, sessions);
  const html = renderCustomViewHtml([
    '<soul-bind kind="card" id="item-1" field="title"></soul-bind>',
    '<soul-bind kind="folder" id="folder-1" field="completed"></soul-bind>',
    '<soul-bind kind="session" id="session" field="status"></soul-bind>',
  ].join(' / '), bindings);

  expect(html).toContain('&lt;검수&gt; / 1 / running');
  expect(html).toContain("default-src 'none'");
  expect(bindings.folders['folder-1']).toEqual({ completed: 1, total: 1 });
});

test('문서 렌더러는 기본 color-scheme을 CSP 뒤, 작성자 스타일 앞에 둔다', () => {
  const html = renderDocumentHtml(
    '<html><head><style>body { background: lavender; }</style></head><body>문서</body></html>',
    buildCustomViewBindings(null, {}),
  );
  const csp = html.indexOf('Content-Security-Policy');
  const baseStyle = html.indexOf('<style>:where(:root){color-scheme:light;}</style>');
  const authorStyle = html.indexOf('<style>body { background: lavender; }</style>');

  expect(html).toContain('<meta charset="utf-8">');
  expect(csp).toBeGreaterThan(-1);
  expect(baseStyle).toBeGreaterThan(csp);
  expect(authorStyle).toBeGreaterThan(baseStyle);
  expect(html).not.toContain('background-color:Canvas');
});
