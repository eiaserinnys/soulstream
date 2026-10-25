jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'completion-operation-id') }));

import { act, renderHook } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { CardDetail, CardDto, CardMutationResult, CardStatus } from '../../../api/cardTypes';
import type { PersistentReportEntry } from '../../../api/types';
import { cardFixture } from '../../../test-support/cards';
import { usePersistentCardCompletion } from '../usePersistentCardCompletion';

const entryA: PersistentReportEntry = {
  key: 'card_531', kind: 'see', title: '첫째 검수 카드', card_numbers: [531], card_id: 'card-531',
  card_status: 'review', context: '첫째 카드를 확인해 주세요.', action: '', options: [], state: 'open',
  answer: '', updated_at: '2026-10-21T00:00:00Z',
};
const entryB: PersistentReportEntry = {
  ...entryA, key: 'card_532', title: '둘째 검수 카드', card_numbers: [532], card_id: 'card-532',
  context: '둘째 카드를 확인해 주세요.',
};

function completionHarness() {
  let card: CardDto = cardFixture({ id: 'card-531', number: 531, status: 'review' });
  const getCard = jest.fn(async () => ({ card: { ...card }, reports: [], questions: [], sessions: [] }) as CardDetail);
  const setCardStatus = jest.fn(async (_id: string, status: CardStatus, version: number) => {
    card = { ...card, status, version: version + 1 };
    return { folderId: card.folderId, card: { ...card } };
  });
  const api = { getCard, setCardStatus } as unknown as ApiClient;
  const entry = { key: 'card_531', kind: 'see' as const, title: '검수 결과', card_numbers: [531], card_id: card.id,
    card_status: 'review', context: '확인해 주세요.', action: '', options: [], state: 'open' as const,
    answer: '', updated_at: '2026-10-21T00:00:00Z' };
  return { api, entry, getCard, setCardStatus };
}

function twoCardHarness() {
  const cards = new Map<string, CardDto>([
    ['card-531', cardFixture({ id: 'card-531', number: 531, status: 'review' })],
    ['card-532', cardFixture({ id: 'card-532', number: 532, status: 'review' })],
  ]);
  const getCard = jest.fn(async (id: string) => ({ card: { ...cards.get(id)! }, reports: [], questions: [], sessions: [] }) as CardDetail);
  const setCardStatus = jest.fn(async (id: string, status: CardStatus, version: number) => {
    const card = { ...cards.get(id)!, status, version: version + 1 };
    cards.set(id, card);
    return { folderId: card.folderId, card };
  });
  return { api: { getCard, setCardStatus } as unknown as ApiClient, getCard, setCardStatus };
}

function delayedHarness(outcome: 'resolve' | 'reject') {
  const cards = new Map<string, CardDto>([
    ['card-531', cardFixture({ id: 'card-531', number: 531, status: 'review' })],
    ['card-532', cardFixture({ id: 'card-532', number: 532, status: 'review' })],
  ]);
  const getCard = jest.fn(async (id: string) => ({ card: { ...cards.get(id)! }, reports: [], questions: [], sessions: [] }) as CardDetail);
  const setCardStatus = jest.fn((id: string, status: CardStatus, version: number) => new Promise<CardMutationResult>((resolve, reject) => {
    if (id === 'card-531' && status === 'done') {
      const card = { ...cards.get(id)!, status, version: version + 1 };
      cards.set(id, card);
      resolve({ folderId: card.folderId, card });
      return;
    }
    setTimeout(() => {
      if (outcome === 'reject') { reject(new Error('카드 저장 실패')); return; }
      const card = { ...cards.get(id)!, status, version: version + 1 };
      cards.set(id, card);
      resolve({ folderId: card.folderId, card });
    }, 1200);
  }));
  return { api: { getCard, setCardStatus } as unknown as ApiClient, getCard, setCardStatus };
}

afterEach(() => jest.useRealTimers());

test('completion moves a review card to done and clears its undo row after five seconds', async () => {
  jest.useFakeTimers();
  const { api, entry, getCard, setCardStatus } = completionHarness();
  const { result, unmount } = renderHook(() => usePersistentCardCompletion(api));
  const completedAt = Date.now();

  await act(async () => { await result.current.complete(entry); });

  expect(getCard).toHaveBeenCalledTimes(1);
  expect(setCardStatus).toHaveBeenCalledTimes(1);
  expect(setCardStatus).toHaveBeenCalledWith('card-531', 'done', 1, 'soul-app-card-completion-operation-id', undefined);
  expect(result.current.recent).toEqual({ cardId: 'card-531', number: 531, label: '#531 완료됨', expiresAt: completedAt + 5000 });
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(result.current.recent).toBeNull();
  unmount();
});

test('undo moves the completed card back to review and clears the undo row', async () => {
  const { api, entry, getCard, setCardStatus } = completionHarness();
  const { result, unmount } = renderHook(() => usePersistentCardCompletion(api));

  await act(async () => { await result.current.complete(entry); });
  await act(async () => { await result.current.undo(); });

  expect(getCard).toHaveBeenCalledTimes(2);
  expect(setCardStatus).toHaveBeenCalledTimes(2);
  expect(setCardStatus.mock.calls.map(call => call[1])).toEqual(['done', 'review']);
  expect(result.current.recent).toBeNull();
  unmount();
});

test('a second completion replaces the undo row and keeps it for its own five seconds', async () => {
  jest.useFakeTimers();
  const { api } = twoCardHarness();
  const { result, unmount } = renderHook(() => usePersistentCardCompletion(api));
  const startedAt = Date.now();

  await act(async () => { await result.current.complete(entryA, [entryA, entryB]); });
  expect(result.current.recent).toEqual({ cardId: 'card-531', number: 531, label: '#531 완료됨', expiresAt: startedAt + 5000 });
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
  await act(async () => { await result.current.complete(entryB, [entryA, entryB]); });
  expect(result.current.recent?.label).toBe('#532 완료됨');
  expect(result.current.recent?.expiresAt).toBe(startedAt + 8000);

  await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
  expect(result.current.recent?.label).toBe('#532 완료됨');
  await act(async () => { await jest.advanceTimersByTimeAsync(3001); });
  expect(result.current.recent).toBeNull();
  unmount();
});

test('a completion in flight past the previous five seconds keeps the undo row', async () => {
  jest.useFakeTimers();
  const { api } = delayedHarness('resolve');
  const { result, unmount } = renderHook(() => usePersistentCardCompletion(api));

  await act(async () => { await result.current.complete(entryA, [entryA, entryB]); });
  await act(async () => { await jest.advanceTimersByTimeAsync(4900); });

  let pending!: Promise<boolean>;
  act(() => { pending = result.current.complete(entryB, [entryA, entryB]); });
  await act(async () => { await jest.advanceTimersByTimeAsync(1100); });

  expect(result.current.recent?.label).toBe('#531 완료됨');
  await act(async () => { await jest.advanceTimersByTimeAsync(300); await pending; });
  expect(result.current.recent?.label).toBe('#532 완료됨');
  unmount();
});

test('an undo in flight past the previous five seconds keeps its row', async () => {
  jest.useFakeTimers();
  const { api, setCardStatus } = delayedHarness('resolve');
  const { result, unmount } = renderHook(() => usePersistentCardCompletion(api));

  await act(async () => { await result.current.complete(entryA, [entryA, entryB]); });
  await act(async () => { await jest.advanceTimersByTimeAsync(4900); });

  let pending!: Promise<boolean>;
  act(() => { pending = result.current.undo(); });
  await act(async () => { await jest.advanceTimersByTimeAsync(1100); });

  expect(result.current.recent?.label).toBe('#531 완료됨');
  let ok: boolean | undefined;
  await act(async () => { await jest.advanceTimersByTimeAsync(300); ok = await pending; });

  expect(ok).toBe(true);
  expect(setCardStatus).toHaveBeenLastCalledWith('card-531', 'review', 2, 'soul-app-card-completion-operation-id', undefined);
  expect(result.current.recent).toBeNull();
  unmount();
});

test('a failed completion restores the remaining time of the previous undo row', async () => {
  jest.useFakeTimers();
  const { api } = delayedHarness('reject');
  const { result, unmount } = renderHook(() => usePersistentCardCompletion(api));
  const startedAt = Date.now();

  await act(async () => { await result.current.complete(entryA, [entryA, entryB]); });
  await act(async () => { await jest.advanceTimersByTimeAsync(2000); });

  let pending!: Promise<boolean>;
  act(() => { pending = result.current.complete(entryB, [entryA, entryB]); });
  await act(async () => { await jest.advanceTimersByTimeAsync(1200); });
  let ok: boolean | undefined;
  await act(async () => { ok = await pending; });

  expect(ok).toBe(false);
  expect(result.current.recent).toEqual({ cardId: 'card-531', number: 531, label: '#531 완료됨', expiresAt: startedAt + 5000 });
  await act(async () => { await jest.advanceTimersByTimeAsync(1799); });
  expect(result.current.recent?.label).toBe('#531 완료됨');
  await act(async () => { await jest.advanceTimersByTimeAsync(2); });
  expect(result.current.recent).toBeNull();
  unmount();
});

test('consecutive completions hide both cards and undo restores only the last one', async () => {
  const { api, setCardStatus } = twoCardHarness();
  const { result, unmount } = renderHook(() => usePersistentCardCompletion(api));

  await act(async () => { await result.current.complete(entryA, [entryA, entryB]); });
  expect(result.current.filterEntries!([entryA, entryB]).map(entry => entry.key)).toEqual(['card_532']);
  await act(async () => { await result.current.complete(entryB, [entryA, entryB]); });
  expect(result.current.filterEntries!([entryA, entryB])).toEqual([]);

  await act(async () => { await result.current.undo(); });

  expect(setCardStatus.mock.calls.map(call => [call[0], call[1]])).toEqual([
    ['card-531', 'done'], ['card-532', 'done'], ['card-532', 'review'],
  ]);
  expect(result.current.filterEntries!([entryA, entryB]).map(entry => entry.key)).toEqual(['card_532']);
  expect(result.current.recent).toBeNull();
  unmount();
});

test('a refreshed server entry releases its optimistic hide', async () => {
  const { api } = twoCardHarness();
  const { result, unmount } = renderHook(() => usePersistentCardCompletion(api));

  await act(async () => { await result.current.complete(entryA, [entryA, entryB]); });
  expect(result.current.filterEntries!([entryA, entryB]).map(entry => entry.key)).toEqual(['card_532']);

  const refreshedA = { ...entryA, updated_at: '2026-10-21T00:01:00Z', title: '서버가 다시 발행한 첫째 카드' };
  expect(result.current.filterEntries!([refreshedA, entryB]).map(entry => entry.key)).toEqual(['card_531', 'card_532']);
  unmount();
});

test('projecting the same report twice keeps the restored card and its position', async () => {
  const { api } = twoCardHarness();
  const { result, unmount } = renderHook(() => usePersistentCardCompletion(api));

  await act(async () => { await result.current.complete(entryA, [entryA, entryB]); });
  await act(async () => { await result.current.complete(entryB, [entryA, entryB]); });
  await act(async () => { await result.current.undo(); });

  const first = result.current.filterEntries!([entryA, entryB]);
  expect(first.map(entry => entry.key)).toEqual(['card_532']);
  const second = result.current.filterEntries!(first);
  expect(second.map(entry => entry.key)).toEqual(['card_532']);
  expect(second[0]).toBe(first[0]);

  const refreshed = result.current.filterEntries!([
    { ...entryA, updated_at: '2026-10-21T00:05:00Z' },
    { ...entryB, updated_at: '2026-10-21T00:06:00Z' },
  ]);
  expect(refreshed.map(entry => entry.key)).toEqual(['card_531', 'card_532']);
  unmount();
});
