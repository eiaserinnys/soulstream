/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PersistentReportEntry } from '@seosoyoung/soul-ui';
import { useCardStore } from '@seosoyoung/soul-ui/cards/card-store';
import type { CardDetail } from '@seosoyoung/soul-ui/cards/card-types';
import { CARD_COMPLETION_UNDO_MS, usePersistentCardCompletion } from './usePersistentCardCompletion';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cardId = 'card-for-completion';
const secondCardId = 'card-for-completion-2';
const entry: PersistentReportEntry & { card_id: string; card_status: string } = {
  key: `card_${cardId}`, kind: 'see', title: '검수 장', card_numbers: [531], card_id: cardId, card_status: 'review',
  context: '', action: '', options: [], state: 'open', answer: '', updated_at: 'review',
};
const second: PersistentReportEntry & { card_id: string; card_status: string } = {
  ...entry, key: `card_${secondCardId}`, title: '두 번째 검수 장', card_numbers: [532], card_id: secondCardId, updated_at: 'second-review',
};
let host: HTMLDivElement;
let root: Root;
let completion: ReturnType<typeof usePersistentCardCompletion>;
let loadCard: ReturnType<typeof vi.fn>;
let mutate: ReturnType<typeof vi.fn>;
const notify = vi.fn();
function Harness({ cardTransition, entries }: { cardTransition?: (id: string, status: 'done' | 'review') => Promise<void>; entries?: PersistentReportEntry[] }) {
  completion = usePersistentCardCompletion(notify, cardTransition);
  return <div><button onClick={() => void completion.complete(entry, entries)}>완료</button><button onClick={() => void completion.complete(second, entries)}>완료B</button><button onClick={() => void completion.undo()}>되돌리기</button>
    <output>{completion.recent?.label ?? ''}</output><output>{String(completion.busy)}</output></div>;
}
const render = (cardTransition?: (id: string, status: 'done' | 'review') => Promise<void>, entries?: PersistentReportEntry[]) => act(async () => root.render(<Harness cardTransition={cardTransition} entries={entries} />));

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
  const completedAt = Date.now();
  await act(async () => completion.complete(entry));
  expect(loadCard).toHaveBeenCalledTimes(1); expect(loadCard).toHaveBeenCalledWith(cardId);
  expect(mutate).toHaveBeenCalledTimes(1); expect(mutate).toHaveBeenCalledWith(cardId, '/status', { status: 'done', expectedVersion: 8 });
  expect(completion.recent).toEqual({ cardId, label: '#531 완료됨', expiresAt: completedAt + CARD_COMPLETION_UNDO_MS });
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

it('keeps the newest completion window across consecutive completions', async () => {
  const current = [entry, second];
  await act(async () => { await completion.complete(entry, current); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  await act(async () => { await completion.complete(second, current); });
  expect(completion.recent?.label).toBe('#532 완료됨');
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(completion.recent?.label).toBe('#532 완료됨');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
  expect(completion.recent?.label).toBe('#532 완료됨');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(completion.recent).toBeNull();
});

it('holds the previous undo row while the next transition is in flight', async () => {
  let release!: () => void;
  const cardTransition = vi.fn(async (id: string) => {
    if (id === secondCardId) await new Promise<void>(resolve => { release = resolve; });
  });
  await render(cardTransition);
  await act(async () => { await completion.complete(entry, [entry, second]); });
  await act(async () => { await vi.advanceTimersByTimeAsync(4_900); });
  let pending!: Promise<boolean>;
  await act(async () => { pending = completion.complete(second, [entry, second]); });
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(completion.recent?.label).toBe('#531 완료됨');
  await act(async () => { release(); await pending; });
  expect(completion.recent?.label).toBe('#532 완료됨');
});

it('restores the previous undo window when the next completion fails', async () => {
  const cardTransition = vi.fn(async (id: string) => { if (id === secondCardId) throw new Error('offline'); });
  await render(cardTransition);
  await act(async () => { await completion.complete(entry, [entry, second]); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  await act(async () => { await completion.complete(second, [entry, second]); });
  expect(completion.recent?.cardId).toBe(cardId);
  await act(async () => { await vi.advanceTimersByTimeAsync(3_999); });
  expect(completion.recent?.cardId).toBe(cardId);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(completion.recent).toBeNull();
});

it('projects only the just-undone card back and keeps earlier completions hidden', async () => {
  await render(vi.fn(async () => {}));
  const current = [entry, second];
  await act(async () => { await completion.complete(entry, current); });
  await act(async () => { await completion.complete(second, current); });
  expect(completion.filterEntries(current)).toEqual([]);
  await act(async () => { await completion.undo(); });
  const projected = completion.filterEntries(current);
  expect(projected.map(item => item.key)).toEqual([second.key]);
  expect(projected[0]?.card_status).toBe('review');
});

it('projects the restored sheet before the stream republishes an empty deck', async () => {
  await render(vi.fn(async () => {}));
  await act(async () => { await completion.complete(entry, [entry]); });
  await act(async () => { await completion.undo(); });
  const projected = completion.filterEntries([]);
  expect(projected.map(item => item.key)).toEqual([entry.key]);
  expect(projected[0]?.card_status).toBe('review');
});
