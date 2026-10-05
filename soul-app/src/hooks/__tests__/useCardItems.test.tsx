import { act, renderHook } from '@testing-library/react-native';
import type { CardCheckItem, CardDetail } from '../../api/cardTypes';
import { cardFixture } from '../../test-support/cards';
import { useCardStore } from '../../store/cardStore';
import { useCardItems } from '../useCardItems';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function item(id: number, display: CardCheckItem['display'] = 'todo'): CardCheckItem {
  return { id, title: `항목 ${id}`, state: 'todo', result: null, evidence: [], caveat: null, rev: 0,
    confirmed: null, fixOpen: 0, reopened: null, from: null, createdAt: '', reportedAt: null, display };
}

test('항목별 확인은 즉시 겹쳐 보이고 성공한 다른 항목을 실패 복구가 덮지 않는다', async () => {
  const card = cardFixture({ id: 'items-card', items: [item(1), item(2)] });
  const detail: CardDetail = { card, reports: [], comments: [], questions: [], sessions: [], notes: [], nowHistory: [] };
  useCardStore.setState({ rows: { [card.id]: card }, details: { [card.id]: detail }, pendingItemConfirmations: {} } as any);
  const first = deferred<{ folderId: string; card: ReturnType<typeof cardFixture> }>();
  const second = deferred<{ folderId: string; card: ReturnType<typeof cardFixture> }>();
  const api = { confirmCardItem: jest.fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise) };
  const alert = jest.spyOn(require('react-native').Alert, 'alert').mockImplementation(() => {});
  const hook = renderHook(() => useCardItems(api as any, card.id));
  let firstRequest!: Promise<boolean>;
  let secondRequest!: Promise<boolean>;

  await act(async () => {
    firstRequest = hook.result.current.confirm(1, true);
    expect(await hook.result.current.confirm(1, true)).toBe(false);
    secondRequest = hook.result.current.confirm(2, true);
    await Promise.resolve();
  });
  expect(api.confirmCardItem.mock.calls).toEqual([[card.id, 1, true], [card.id, 2, true]]);
  expect(useCardStore.getState().pendingItemConfirmations).toMatchObject({
    [card.id]: { 1: { confirmed: true }, 2: { confirmed: true } },
  });

  const confirmedCard = cardFixture({ id: card.id, version: 2, items: [item(1), {
    ...item(2, 'confirmed'), confirmed: { at: '2026-10-05T00:00:00Z', rev: 0 },
  }] });
  await act(async () => {
    second.resolve({ folderId: card.folderId, card: confirmedCard });
    expect(await secondRequest).toBe(true);
  });
  expect(useCardStore.getState().rows[card.id].version).toBe(2);
  expect(useCardStore.getState().details[card.id].card.items?.[1].display).toBe('confirmed');
  expect(useCardStore.getState().pendingItemConfirmations[card.id]).toEqual({ 1: { confirmed: true, requestId: expect.any(String) } });

  await act(async () => {
    first.reject(new Error('확인 실패'));
    expect(await firstRequest).toBe(false);
  });
  expect(useCardStore.getState().details[card.id].card.version).toBe(2);
  expect(useCardStore.getState().details[card.id].card.items?.[1].display).toBe('confirmed');
  expect(useCardStore.getState().pendingItemConfirmations[card.id] ?? {}).toEqual({});
  expect(alert).toHaveBeenCalledWith('항목 확인 실패', '확인 실패');
});
