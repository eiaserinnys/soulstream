/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ChatMessageItem } from './ChatMessageItem';
import { ChatUiControllerProvider } from '../chat-ui/ChatUiControllerProvider';
import type { ChatMessage } from '../../lib/flatten-tree';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('UI 그림 첨부는 답 아래 첨부 줄에 다시 표시하지 않는다', async () => {
  const doc = { schema_version: 1, body: [{ id: 'picture', kind: 'image', attachment_id: 'image-one', alt: '그래프' }] };
  const ui = { schema_version: 1, revision: 1, ui_id: 'ui_test', hash: 'hash', document: doc };
  const msg = { id: 'assistant-image', role: 'assistant', content: '그래프', treeNodeId: 'assistant-image', treeNodeType: 'assistant_message', eventId: 601, attachmentIds: ['image-one', 'other'], ui } as ChatMessage;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ event_id: 601, items: ['image-one', 'other'].map(id => ({ kind: 'asset', descriptor: { attachment_id: id, name: `${id}.png`, mime_type: 'image/png', byte_size: 4, checksum_sha256: null, width: null, height: null, preview_kind: 'image', preview_mime_type: null }, read_context: { type: 'session', id: 'session-a' }, legacy_sources: [] })) }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => { root.render(<ChatUiControllerProvider sessionId="session-a"><ChatMessageItem msg={msg} sessionId="session-a" /></ChatUiControllerProvider>); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.querySelector('[data-chat-ui-node="picture"] img')?.getAttribute('src')).toContain('image-one');
  await vi.waitFor(() => expect(host.querySelectorAll('img[src*="/other/content"]')).toHaveLength(1));
  expect(host.querySelectorAll('img[src*="/image-one/content"]')).toHaveLength(1);
  expect(host.querySelector('[data-chat-ui-node="picture"] img')?.getAttribute('src')).toContain('/image-one/content');
  act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();
});
