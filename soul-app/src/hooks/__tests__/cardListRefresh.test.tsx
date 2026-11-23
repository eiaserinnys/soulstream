import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import { CARD_REFRESH_WINDOW_MS } from '../../lib/card-refresh-window';
import { useCardStore } from '../../store/cardStore';
import { usePlannerStore } from '../../store/plannerStore';
import { cardFixture } from '../../test-support/cards';
import { useCardList } from '../useCardList';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  useCardStore.setState({ rows: {}, seq: 0, rowSeq: {}, details: {}, pendingItemConfirmations: {} });
  usePlannerStore.getState().resetForTest();
});

afterEach(() => {
  jest.useRealTimers();
});

test('숨김 동안에는 목록을 조회하지 않고, 다시 보이면 최신 목록을 한 번 조회한다', async () => {
  const listCards = jest.fn()
    .mockResolvedValueOnce({ cards: [cardFixture({ id: 'card-a', status: 'running' })] })
    .mockResolvedValue({
      cards: [cardFixture({ id: 'card-a', status: 'running' }), cardFixture({ id: 'card-b' })],
    });
  const api = { listCards } as unknown as ApiClient;
  const hook = renderHook<ReturnType<typeof useCardList>, { visible: boolean }>(
    ({ visible }) => useCardList(api, undefined, visible),
    { initialProps: { visible: true } },
  );
  await waitFor(() => expect(hook.result.current.cards).toHaveLength(1));

  hook.rerender({ visible: false });
  act(() => {
    usePlannerStore.getState().invalidate('card');
    usePlannerStore.getState().invalidate('card');
    usePlannerStore.getState().invalidate('folder');
  });
  expect(listCards).toHaveBeenCalledTimes(1);

  hook.rerender({ visible: true });
  await waitFor(() => expect(hook.result.current.cards).toHaveLength(2));
  expect(listCards).toHaveBeenCalledTimes(2);
});

test('숨겼다가 사건 없이 되돌아오면 목록을 다시 조회하지 않는다', async () => {
  const listCards = jest.fn().mockResolvedValue({ cards: [cardFixture({ id: 'card-a' })] });
  const api = { listCards } as unknown as ApiClient;
  const hook = renderHook<ReturnType<typeof useCardList>, { visible: boolean }>(
    ({ visible }) => useCardList(api, undefined, visible),
    { initialProps: { visible: true } },
  );
  await waitFor(() => expect(hook.result.current.cards).toHaveLength(1));

  hook.rerender({ visible: false });
  hook.rerender({ visible: true });

  expect(listCards).toHaveBeenCalledTimes(1);
});

test('카드 무효화가 몰려 오면 한 창으로 묶어 한 번만 조회한다', async () => {
  jest.useFakeTimers();
  const listCards = jest.fn().mockResolvedValue({ cards: [cardFixture({ id: 'card-a' })] });
  const api = { listCards } as unknown as ApiClient;
  renderHook(() => useCardList(api));
  await flushPromises();
  expect(listCards).toHaveBeenCalledTimes(1);

  act(() => usePlannerStore.getState().invalidate('card'));
  await act(async () => { jest.advanceTimersByTime(300); });
  act(() => usePlannerStore.getState().invalidate('card'));
  await act(async () => { jest.advanceTimersByTime(CARD_REFRESH_WINDOW_MS - 1); });
  expect(listCards).toHaveBeenCalledTimes(1);

  await act(async () => {
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(listCards).toHaveBeenCalledTimes(2);
});

test('폴더 무효화는 즉시 조회하고 카드 무효화만 창으로 미룬다', async () => {
  jest.useFakeTimers();
  const listCards = jest.fn().mockResolvedValue({ cards: [cardFixture({ id: 'card-a' })] });
  const api = { listCards } as unknown as ApiClient;
  renderHook(() => useCardList(api));
  await flushPromises();
  expect(listCards).toHaveBeenCalledTimes(1);

  act(() => usePlannerStore.getState().invalidate('folder'));
  await flushPromises();
  expect(listCards).toHaveBeenCalledTimes(2);

  act(() => usePlannerStore.getState().invalidate('card'));
  await act(async () => { jest.advanceTimersByTime(CARD_REFRESH_WINDOW_MS - 1); });
  expect(listCards).toHaveBeenCalledTimes(2);
  await act(async () => {
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(listCards).toHaveBeenCalledTimes(3);
});

test('숨겼다가 다시 보일 때 이전 요청의 늦은 응답은 버린다', async () => {
  const first = deferred<{ cards: CardDto[] }>();
  const listCards = jest.fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ cards: [cardFixture({ id: 'card-new' })] });
  const api = { listCards } as unknown as ApiClient;
  const hook = renderHook<ReturnType<typeof useCardList>, { visible: boolean }>(
    ({ visible }) => useCardList(api, undefined, visible),
    { initialProps: { visible: true } },
  );
  await waitFor(() => expect(listCards).toHaveBeenCalledTimes(1));

  hook.rerender({ visible: false });
  hook.rerender({ visible: true });
  await waitFor(() => expect(listCards).toHaveBeenCalledTimes(2));

  await act(async () => { first.resolve({ cards: [cardFixture({ id: 'card-old' })] }); });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));

  expect(hook.result.current.cards.map((card) => card.id)).toEqual(['card-new']);
});
