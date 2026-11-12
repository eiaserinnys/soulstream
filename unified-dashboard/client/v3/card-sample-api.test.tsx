/** @vitest-environment jsdom */
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import type { CardDetail, CardRow } from '@seosoyoung/soul-ui/cards/card-types';
import { useCardApiSample } from './card-sample-api';

const cardRow = (id: string): CardRow => ({
  id, folderId: 'folder', number: 1, title: `카드 ${id}`, request: '', brief: '', attachments: [],
  status: 'running', blockedKind: null, blockedDetail: null, positionKey: 'a', queuePositionKey: null,
  assigneeKind: null, assigneeAgentId: null, assigneeUserId: null, assigneeSessionId: null, nodeId: null,
  modelPreset: null, version: 1, archived: false, createdAt: '', updatedAt: '',
});
const detailOf = (id: string): CardDetail => ({ card: cardRow(id), sessions: [], questions: [], comments: [], reports: [] });
const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** 검수 창처럼 표본 여러 개가 한 화면에 함께 마운트되는 상황을 만든다. */
function Sample({ detail }: { detail: CardDetail }) {
  const ref = useRef(detail);
  useCardApiSample(ref);
  useEffect(() => {
    const store = useCardStore.getState();
    store.putCards([detail.card]);
    void store.loadCard(detail.card.id).catch(() => undefined);
  }, [detail]);
  return null;
}

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  useCardStore.getState().reset();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount()); container.remove();
  useCardStore.getState().reset(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it('lets a card sample answer only its own card requests', async () => {
  const first = detailOf('card-a'), second = detailOf('card-b');
  const request = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const detail = [first, second].find(item => url.pathname === `/api/cards/${item.card.id}`);
    if (detail) return respond(detail);
    if (url.pathname === '/api/cards') return respond({ cards: [] });
    throw new Error(`unexpected request: ${url.pathname}`);
  });
  vi.stubGlobal('fetch', request);
  await act(async () => { root.render(<><Sample detail={first} /><Sample detail={second} /></>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(useCardStore.getState().errors['card-a'] ?? '').toBe('');
  expect(useCardStore.getState().errors['card-b'] ?? '').toBe('');
  expect(useCardStore.getState().details['card-a']?.card.id).toBe('card-a');
  expect(useCardStore.getState().details['card-b']?.card.id).toBe('card-b');
});
