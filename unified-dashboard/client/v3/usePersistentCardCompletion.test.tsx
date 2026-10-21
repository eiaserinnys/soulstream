/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PersistentReportEntry } from '@seosoyoung/soul-ui';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import type { CardDetail } from '@seosoyoung/soul-ui/cards/card-types';
import { usePersistentCardCompletion } from './usePersistentCardCompletion';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cardId = 'card-for-completion';
const entry: PersistentReportEntry & { card_id: string; card_status: string } = {
  key: `card_${cardId}`, kind: 'see', title: '검수 장', card_numbers: [531], card_id: cardId, card_status: 'review',
  context: '', action: '', options: [], state: 'open', answer: '', updated_at: 'review',
};
let host: HTMLDivElement;
let root: Root;
let completion: ReturnType<typeof usePersistentCardCompletion>;
let loadCard: ReturnType<typeof vi.fn>;
let mutate: ReturnType<typeof vi.fn>;
const notify = vi.fn();
function Harness({ cardTransition }: { cardTransition?: (id: string, status: 'done' | 'review') => Promise<void> }) {
  completion = usePersistentCardCompletion(notify, cardTransition);
  return <div><button onClick={() => void completion.complete(entry)}>완료</button><button onClick={() => void completion.undo()}>되돌리기</button>
    <output>{completion.recent?.label ?? ''}</output><output>{String(completion.busy)}</output></div>;
}
const render = (cardTransition?: (id: string, status: 'done' | 'review') => Promise<void>) => act(async () => root.render(<Harness cardTransition={cardTransition} />));

beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks();
  const card = { id: cardId, status: 'review', version: 8 } as CardDetail['card'];
  loadCard = vi.fn().mockResolvedValue({ card } as CardDetail);
  mutate = vi.fn().mockResolvedValue({ card } as CardDetail);
  useCardStore.setState({ loadCard, mutate });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); await render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('loads the current card and completes once with its latest version', async () => {
  await act(async () => completion.complete(entry));
  expect(loadCard).toHaveBeenCalledTimes(1); expect(loadCard).toHaveBeenCalledWith(cardId);
  expect(mutate).toHaveBeenCalledTimes(1); expect(mutate).toHaveBeenCalledWith(cardId, '/status', { status: 'done', expectedVersion: 8 });
  expect(completion.recent).toEqual({ cardId, label: '#531 완료됨' });
});

it('rejects completion when the latest card status is no longer review', async () => {
  loadCard.mockResolvedValue({ card: { id: cardId, status: 'running', version: 9 } } as CardDetail);
  await act(async () => completion.complete(entry));
  expect(mutate).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledWith('카드 상태가 바뀌었어.');
  expect(completion.recent).toBeNull();
});

it('keeps the undo row for five seconds, then clears it', async () => {
  await act(async () => completion.complete(entry));
  await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
  expect(completion.recent?.label).toBe('#531 완료됨');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(completion.recent).toBeNull();
});

it('returns the completed card to review through the injected transition', async () => {
  const cardTransition = vi.fn(async () => {});
  await render(cardTransition);
  await act(async () => completion.complete(entry));
  await act(async () => completion.undo());
  expect(cardTransition.mock.calls).toEqual([[cardId, 'done'], [cardId, 'review']]);
  expect(completion.recent).toBeNull();
});

it('reports a failed completion and leaves no undo row', async () => {
  mutate.mockRejectedValue(new Error('offline'));
  await act(async () => completion.complete(entry));
  expect(notify).toHaveBeenCalledTimes(1); expect(notify).toHaveBeenCalledWith('카드를 완료하지 못했어.');
  expect(completion.recent).toBeNull();
});

it('reports an undo failure and keeps its row available until expiry', async () => {
  loadCard.mockResolvedValueOnce({ card: { id: cardId, status: 'review', version: 8 } } as CardDetail)
    .mockResolvedValueOnce({ card: { id: cardId, status: 'done', version: 9 } } as CardDetail);
  await act(async () => completion.complete(entry));
  mutate.mockRejectedValueOnce(new Error('offline'));
  await act(async () => completion.undo());
  expect(notify).toHaveBeenCalledWith('되돌리지 못했어.');
  expect(completion.recent?.cardId).toBe(cardId);
});

it('rejects undo when the current card status is no longer done', async () => {
  loadCard.mockResolvedValueOnce({ card: { id: cardId, status: 'review', version: 8 } } as CardDetail)
    .mockResolvedValueOnce({ card: { id: cardId, status: 'running', version: 9 } } as CardDetail);
  await act(async () => completion.complete(entry));
  await act(async () => completion.undo());
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith('카드 상태가 바뀌었어.');
  expect(completion.recent?.cardId).toBe(cardId);
});
