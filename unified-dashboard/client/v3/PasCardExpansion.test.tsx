/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PersistentReportEntry } from '@seosoyoung/soul-ui';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import { InternalLinkProvider } from '@seosoyoung/soul-ui/components/InternalLinkProvider';
import type { CardComment, CardDetail, CardRow } from '@seosoyoung/soul-ui/cards/card-types';
import { PasCardExpansion } from './PasCardExpansion';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@seosoyoung/soul-ui/cards/card-api', async importOriginal => ({ ...await importOriginal<object>(), cardRequest: request, cardMutationKey: () => 'mutation-key', confirmCardItem: (cardId: string, itemId: number, confirmed: boolean) => request(`/api/cards/${cardId}/items/${itemId}/confirm`, 'POST', { confirmed }) }));
vi.mock('./CardNowPanel', () => ({ CardNowPanel: ({ now, itemsCount }: { now?: { text: string } | null; itemsCount: number }) => <div data-testid="now">{now?.text}:{itemsCount}</div> }));
vi.mock('./CardCheckItems', () => ({ CardCheckItems: ({ items, onConfirmChange, onTargetItem }: { items?: readonly { id: number }[] | null; onConfirmChange(id: number, confirmed: boolean): void | Promise<void>; onTargetItem(id: number): void }) => <div data-testid="items">
  <span>{items?.length ?? 0}</span><button data-testid="confirm-item" onClick={() => void onConfirmChange(4, true)}>확인</button><button data-testid="target-item" onClick={() => onTargetItem(4)}>고칠 점 남기기</button>
</div> }));
vi.mock('./CardTimeline', () => ({ CardTimeline: ({ detail, commentsOnly }: { detail?: CardDetail; commentsOnly: boolean }) => <div data-testid="comments" data-comments-only={commentsOnly}>{detail?.comments?.map(comment => <p key={comment.id}>{comment.body}</p>)}</div> }));
vi.mock('./CardCommentInput', () => ({ CardCommentInput: ({ placeholder, onSend, focusRequest }: { placeholder: string; onSend(body: string): Promise<boolean>; focusRequest?: number }) => <div data-focus-request={focusRequest ?? 0}><p data-testid="placeholder">{placeholder}</p><button data-testid="send" onClick={async () => { await onSend('작성한 글'); }}>보내기</button></div> }));

const card: CardRow = { id: 'card-id', number: 531, folderId: 'folder', title: '검수 카드', request: '', brief: '', attachments: [], status: 'review', blockedKind: null, blockedDetail: null, positionKey: 'a', queuePositionKey: null, assigneeKind: 'session', assigneeAgentId: 'roselin', assigneeUserId: null, assigneeSessionId: 'session-id', nodeId: 'eiaserinnys', modelPreset: null, version: 1, archived: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  items: [{ id: 4, title: '항목', state: 'todo', result: '결과', evidence: [], caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: '2026-10-01T00:00:00Z', reportedAt: null, display: 'todo' }],
  now: { text: '현재 상황', turn: 'user', ask: '확인해 주세요.', updatedAt: '2026-10-01T00:00:00Z', sessionId: 'session-id' },
};
const comment = (id: string, body: string, createdAt: string): CardComment => ({ id, cardId: card.id, authorKind: 'user', authorId: '', sessionId: null, kind: 'comment', body, createdAt });
let detail: CardDetail;
let root: Root;
let host: HTMLDivElement;
const entry: PersistentReportEntry & { card_id: string; card_status: string } = { key: `card_${card.id}`, kind: 'see', title: '검수 카드', card_numbers: [531], card_id: card.id, card_status: 'review', context: '', action: '', options: [], state: 'open', answer: '', updated_at: 'first' };
const openTarget = vi.fn();
const render = (currentEntry: PersistentReportEntry = entry) => act(async () => root.render(<InternalLinkProvider internalOrigins={['http://localhost']} openTarget={openTarget}><PasCardExpansion entry={currentEntry} lookupCards={vi.fn().mockResolvedValue(undefined)} /></InternalLinkProvider>));

beforeEach(async () => {
  vi.clearAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  detail = { card, sessions: [], questions: [
    { id: 'other-open', text: '다른 질문', options: null, answer: null, askedAt: '2026-10-01T00:00:00Z', answeredAt: null },
    { id: 'question-target', text: '이 질문', options: ['선택'], answer: null, askedAt: '2026-10-01T00:00:00Z', answeredAt: null },
    { id: 'answered', text: '이미 답한 질문', options: null, answer: '답', askedAt: '2026-10-01T00:00:00Z', answeredAt: '2026-10-01T00:01:00Z' },
    { id: 'withdrawn', text: '철회한 질문', options: null, answer: null, askedAt: '2026-10-01T00:00:00Z', answeredAt: null, withdrawnAt: '2026-10-01T00:01:00Z' },
  ], comments: [comment('old', '오래된 커멘트', '2026-10-01T01:00:00Z'), comment('middle', '중간 커멘트', '2026-10-01T02:00:00Z'), comment('new', '최근 커멘트', '2026-10-01T03:00:00Z')], reports: [] };
  request.mockImplementation(async (path: string, method?: string, body?: unknown) => {
    if (path === `/api/cards/${card.id}`) return detail;
    if (path.endsWith('/items/4/confirm')) return { card: { ...card, version: 2 } };
    if (path.endsWith('/comments')) return comment('saved', (body as { body: string }).body, '2026-10-01T04:00:00Z');
    return detail;
  });
  useCardStore.getState().reset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await render();
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); useCardStore.getState().reset(); vi.restoreAllMocks(); });

it('loads the linked card and shows only its current panel, items, and two latest comments', async () => {
  expect(request).toHaveBeenCalledWith(`/api/cards/${card.id}`);
  expect(host.querySelector('[data-testid="now"]')?.textContent).toBe('현재 상황:1');
  expect(host.querySelector('[data-testid="items"]')?.textContent).toContain('1');
  expect(host.querySelector('[data-testid="comments"]')?.getAttribute('data-comments-only')).toBe('true');
  expect(host.querySelector('[data-testid="comments"]')?.textContent).toContain('중간 커멘트');
  expect(host.querySelector('[data-testid="comments"]')?.textContent).toContain('최근 커멘트');
  expect(host.querySelector('[data-testid="comments"]')?.textContent).not.toContain('오래된 커멘트');
  const openCard = host.querySelector<HTMLAnchorElement>('a[href="/?card=card-id"]')!;
  expect(openCard).not.toBeNull();
  await act(async () => openCard.click());
  expect(openTarget).toHaveBeenCalledWith({ kind: 'card', cardId: card.id }, `/?card=${card.id}`);
});

it('confirms a check item through the existing card store action', async () => {
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="confirm-item"]')!.click());
  expect(request).toHaveBeenCalledWith(`/api/cards/${card.id}/items/4/confirm`, 'POST', { confirmed: true });
});

it('answers the linked open question before using a card comment', async () => {
  await render({ ...entry, question_id: 'question-target' });
  expect(host.querySelector('[data-testid="placeholder"]')?.textContent).toBe('질문에 답하기');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="send"]')!.click());
  expect(request).toHaveBeenCalledWith(`/api/cards/${card.id}/questions/question-target/answer`, 'POST', expect.objectContaining({ answer: '작성한 글' }));
  expect(request).not.toHaveBeenCalledWith(`/api/cards/${card.id}/comments`, 'POST', expect.anything());
});

it('routes a targeted correction to an item comment before answering an open question', async () => {
  expect(host.querySelector('[data-focus-request]')?.getAttribute('data-focus-request')).toBe('0');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="target-item"]')!.click());
  expect(host.querySelector('[data-focus-request]')?.getAttribute('data-focus-request')).toBe('1');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="send"]')!.click());
  expect(request).toHaveBeenCalledWith(`/api/cards/${card.id}/comments`, 'POST', expect.objectContaining({ body: '작성한 글', itemId: 4 }));
  expect(request).not.toHaveBeenCalledWith(expect.stringContaining('/questions/'), 'POST', expect.anything());
});

it('uses a card comment when no unanswered, unwithdrawn question remains', async () => {
  detail = { ...detail, questions: detail.questions.map(question => ({ ...question, answer: '답', answeredAt: '2026-10-01T00:01:00Z' })) };
  await act(async () => useCardStore.setState({ details: { [card.id]: detail }, byId: { [card.id]: card } }));
  request.mockClear();
  await render();
  expect(host.querySelector('[data-testid="placeholder"]')?.textContent).toBe('커멘트');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="send"]')!.click());
  expect(request).toHaveBeenCalledWith(`/api/cards/${card.id}/comments`, 'POST', expect.objectContaining({ body: '작성한 글' }));
});
