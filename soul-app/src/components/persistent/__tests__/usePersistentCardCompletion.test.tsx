jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'completion-operation-id') }));

import { act, renderHook } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { CardDetail, CardDto, CardStatus } from '../../../api/cardTypes';
import { cardFixture } from '../../../test-support/cards';
import { usePersistentCardCompletion } from '../usePersistentCardCompletion';

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
