import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import { cardFixture } from '../../test-support/cards';
import { useCardList } from '../useCardList';
import { usePlannerFolder } from '../usePlannerFolder';
import { useCardStore } from '../../store/cardStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  useCardStore.setState({ rows: {}, seq: 0, rowSeq: {}, details: {}, pendingItemConfirmations: {} });
});

test('요청 전에 store에만 있던 행은 목록 스냅숏에서 빠진다', async () => {
  const stale = cardFixture({ id: 'finished-card', status: 'review' });
  act(() => useCardStore.getState().putCard(stale));
  const response = deferred<{ cards: typeof stale[] }>();
  const listCards = jest.fn(() => response.promise);
  const api = { listCards } as unknown as ApiClient;

  const hook = renderHook(() => useCardList(api));
  await waitFor(() => expect(listCards).toHaveBeenCalledTimes(1));
  await act(async () => response.resolve({ cards: [] }));

  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.cards).toEqual([]);
});

test('요청이 시작된 뒤 store에 추가된 행은 스냅숏에 없어도 보인다', async () => {
  const response = deferred<{ cards: ReturnType<typeof cardFixture>[] }>();
  const listCards = jest.fn(() => response.promise);
  const api = { listCards } as unknown as ApiClient;
  const hook = renderHook(() => useCardList(api));
  await waitFor(() => expect(listCards).toHaveBeenCalledTimes(1));

  const late = cardFixture({ id: 'late-card', title: '새 카드' });
  act(() => useCardStore.getState().putCard(late));
  await act(async () => response.resolve({ cards: [] }));

  await waitFor(() => expect(hook.result.current.cards.map((card) => card.id)).toEqual(['late-card']));
});

test('목록과 store에 같은 카드가 있으면 version이 높은 행을 쓴다', async () => {
  const response = deferred<{ cards: ReturnType<typeof cardFixture>[] }>();
  const listCards = jest.fn(() => response.promise);
  const api = { listCards } as unknown as ApiClient;
  const hook = renderHook(() => useCardList(api));
  await waitFor(() => expect(listCards).toHaveBeenCalledTimes(1));

  act(() => useCardStore.getState().putCard(cardFixture({ id: 'same-card', version: 2, title: 'store 최신' })));
  await act(async () => response.resolve({ cards: [cardFixture({ id: 'same-card', version: 1, title: '목록 이전' })] }));

  await waitFor(() => expect(hook.result.current.cards[0]?.title).toBe('store 최신'));
});

test('폴더 요청 전에 store에만 있던 행은 폴더 스냅숏에서 빠진다', async () => {
  const stale = cardFixture({ id: 'finished-folder-card', folderId: 'folder-1', status: 'review' });
  act(() => useCardStore.getState().putCard(stale));
  const response = deferred<{ folder: { id: string; title: string }; cards: typeof stale[] }>();
  const getFolderSnapshot = jest.fn(() => response.promise);
  const api = { getFolderSnapshot } as unknown as ApiClient;

  const hook = renderHook(() => usePlannerFolder(api, 'folder-1'));
  await waitFor(() => expect(getFolderSnapshot).toHaveBeenCalledTimes(1));
  await act(async () => response.resolve({ folder: { id: 'folder-1', title: '업무' }, cards: [] }));

  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.data?.cards).toEqual([]);
});
