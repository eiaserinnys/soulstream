import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../api/client';
import type { CardDto } from '../../api/cardTypes';
import { CARD_REFRESH_WINDOW_MS } from '../../lib/card-refresh-window';
import { useCardStore } from '../../store/cardStore';
import { usePlannerStore } from '../../store/plannerStore';
import { cardFixture } from '../../test-support/cards';
import { useCardList } from '../useCardList';
import { useCardActions } from '../useCardActions';
import { useCardComments } from '../useCardComments';

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

test('숨겼다가 사건 없이 되돌아와도 최신 목록을 한 번 조회한다', async () => {
  const listCards = jest.fn().mockResolvedValue({ cards: [cardFixture({ id: 'card-a' })] });
  const api = { listCards } as unknown as ApiClient;
  const hook = renderHook<ReturnType<typeof useCardList>, { visible: boolean }>(
    ({ visible }) => useCardList(api, undefined, visible),
    { initialProps: { visible: true } },
  );
  await waitFor(() => expect(hook.result.current.cards).toHaveLength(1));

  hook.rerender({ visible: false });
  hook.rerender({ visible: true });
  await flushPromises();

  expect(listCards).toHaveBeenCalledTimes(2);
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

test('카드 사건 뒤 조회 전에 숨겼다가 돌아와도 최신 목록을 받는다', async () => {
  jest.useFakeTimers();
  const listCards = jest.fn()
    .mockResolvedValueOnce({ cards: [cardFixture({ id: 'card-a' })] })
    .mockResolvedValue({ cards: [cardFixture({ id: 'card-a' }), cardFixture({ id: 'card-new' })] });
  const api = { listCards } as unknown as ApiClient;
  const hook = renderHook<ReturnType<typeof useCardList>, { visible: boolean }>(
    ({ visible }) => useCardList(api, undefined, visible), { initialProps: { visible: true } },
  );
  await flushPromises();
  act(() => usePlannerStore.getState().invalidate('card'));
  hook.rerender({ visible: false });
  hook.rerender({ visible: true });
  await flushPromises();
  expect(listCards).toHaveBeenCalledTimes(2);
  expect(hook.result.current.cards.map(card => card.id)).toEqual(['card-a', 'card-new']);
});

test('카드 사건 후 지연 창에서 이전 목록 응답이 와도 전역 행에 반영하지 않는다', async () => {
  jest.useFakeTimers();
  const old = deferred<{ cards: CardDto[] }>();
  const listCards = jest.fn().mockReturnValueOnce(old.promise)
    .mockResolvedValue({ cards: [cardFixture({ id: 'card-new' })] });
  const api = { listCards } as unknown as ApiClient;
  const hook = renderHook(() => useCardList(api));
  act(() => usePlannerStore.getState().invalidate('card'));
  await act(async () => { old.resolve({ cards: [cardFixture({ id: 'card-old' })] }); });
  expect(useCardStore.getState().rows['card-old']).toBeUndefined();
  await act(async () => { jest.advanceTimersByTime(CARD_REFRESH_WINDOW_MS); });
  await flushPromises();
  expect(hook.result.current.cards.map(card => card.id)).toEqual(['card-new']);
});

test('숨김으로 바뀐 뒤 늦은 목록 응답은 전역 행에 반영하지 않는다', async () => {
  const old = deferred<{ cards: CardDto[] }>();
  const listCards = jest.fn().mockReturnValue(old.promise);
  const api = { listCards } as unknown as ApiClient;
  const hook = renderHook<ReturnType<typeof useCardList>, { visible: boolean }>(
    ({ visible }) => useCardList(api, undefined, visible), { initialProps: { visible: true } },
  );
  hook.rerender({ visible: false });
  await act(async () => { old.resolve({ cards: [cardFixture({ id: 'card-old' })] }); });
  expect(useCardStore.getState().rows['card-old']).toBeUndefined();
});

test('직접 변경과 커멘트, replay, 폴더 전환은 카드 병합 창을 기다리지 않는다', async () => {
  jest.useFakeTimers();
  const listCards = jest.fn().mockResolvedValue({ cards: [] });
  const addCardComment = jest.fn(async (_id: string, input: { body: string }) => ({
    id: 'saved-comment', cardId: 'card-a', authorKind: 'user', authorId: null, sessionId: null,
    kind: 'comment', body: input.body, createdAt: new Date().toISOString(),
  }));
  const api = { listCards, addCardComment } as unknown as ApiClient;
  const hook = renderHook(({ folder }: { folder: string }) => ({
    list: useCardList(api, folder), actions: useCardActions(api), comments: useCardComments(api, 'card-a'),
  }), { initialProps: { folder: 'folder-1' } });
  await flushPromises();
  act(() => usePlannerStore.getState().invalidate('card'));
  await act(async () => { await hook.result.current.actions.run(async () => ({ card: null } as never)); });
  expect(listCards).toHaveBeenCalledTimes(2);
  await act(async () => { await hook.result.current.comments.send('내용'); });
  expect(listCards).toHaveBeenCalledTimes(3);
  act(() => usePlannerStore.getState().invalidate('replay'));
  await flushPromises();
  expect(listCards).toHaveBeenCalledTimes(4);
  hook.rerender({ folder: 'folder-2' });
  await flushPromises();
  expect(listCards).toHaveBeenCalledTimes(5);
  expect(listCards).toHaveBeenLastCalledWith('folder-2', { includeCompleted: false });
  await act(async () => { jest.advanceTimersByTime(CARD_REFRESH_WINDOW_MS); });
  expect(listCards).toHaveBeenCalledTimes(5);
});
