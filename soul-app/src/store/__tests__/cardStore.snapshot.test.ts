import type { CardDetail } from '../../api/cardTypes';
import { resetAuthScopeForTest } from '../../lib/auth-scope';
import { cardFixture } from '../../test-support/cards';
import { mergeCardRows, useCardStore } from '../cardStore';

beforeEach(() => {
  useCardStore.setState({ rows: {}, seq: 0, rowSeq: {}, details: {}, pendingItemConfirmations: {} });
});

test('행 쓰기 세 경로는 순서를 남기고 낮은 version은 순서를 바꾸지 않는다', () => {
  const store = useCardStore.getState();
  store.putCard(cardFixture({ id: 'card-a', version: 2 }));
  expect(useCardStore.getState()).toMatchObject({ seq: 1, rowSeq: { 'card-a': 1 } });

  useCardStore.getState().putCard(cardFixture({ id: 'card-a', version: 1 }));
  expect(useCardStore.getState()).toMatchObject({ seq: 1, rowSeq: { 'card-a': 1 } });

  const detail = {
    card: cardFixture({ id: 'card-a', version: 3 }),
    reports: [], comments: [], questions: [], sessions: [],
  } as CardDetail;
  useCardStore.getState().putDetail(detail);
  expect(useCardStore.getState()).toMatchObject({ seq: 2, rowSeq: { 'card-a': 2 } });
  useCardStore.getState().putDetail({ ...detail, card: cardFixture({ id: 'card-a', version: 2 }) });
  expect(useCardStore.getState()).toMatchObject({ seq: 2, rowSeq: { 'card-a': 2 } });

  useCardStore.getState().putMutationCard(cardFixture({ id: 'card-a', version: 4 }));
  expect(useCardStore.getState()).toMatchObject({ seq: 3, rowSeq: { 'card-a': 3 } });
  useCardStore.getState().putMutationCard(cardFixture({ id: 'card-a', version: 3 }));
  expect(useCardStore.getState()).toMatchObject({ seq: 3, rowSeq: { 'card-a': 3 } });
});

test('인증 scope가 바뀌면 행과 함께 sequence도 초기화한다', () => {
  useCardStore.getState().putCard(cardFixture({ id: 'card-a' }));
  resetAuthScopeForTest();

  expect(useCardStore.getState()).toMatchObject({ rows: {}, seq: 0, rowSeq: {} });
});

test('목록 일괄 쓰기는 낮은 version 행을 버리고 최신 행과 상세를 갱신한다', () => {
  useCardStore.getState().putCard(cardFixture({ id: 'card-a', version: 5, status: 'review' }));
  const detail = {
    card: cardFixture({ id: 'card-a', version: 5, status: 'review' }),
    reports: [], comments: [], questions: [], sessions: [],
  } as CardDetail;
  useCardStore.getState().putDetail(detail);

  const snapshotSeq = useCardStore.getState().seq;
  useCardStore.getState().putCards([
    cardFixture({ id: 'card-a', version: 3, status: 'running' }),
    cardFixture({ id: 'card-b', version: 1 }),
  ], snapshotSeq);

  const state = useCardStore.getState();
  expect(state.rows['card-a']).toMatchObject({ version: 5, status: 'review' });
  expect(state.rows['card-b']).toMatchObject({ version: 1 });
  expect(state.rowSeq).toEqual({ 'card-a': 2, 'card-b': 3 });

  useCardStore.getState().putCards([cardFixture({ id: 'card-a', version: 5, status: 'done' })], state.seq);
  expect(useCardStore.getState().rows['card-a']).toMatchObject({ version: 5, status: 'done' });
  expect(useCardStore.getState().details['card-a']?.card.status).toBe('done');
  expect(useCardStore.getState().seq).toBe(4);

  const newer = cardFixture({ id: 'card-a', version: 6, status: 'done' });
  useCardStore.getState().putCards([newer], snapshotSeq);
  expect(useCardStore.getState().rows['card-a']).toBe(newer);
  expect(useCardStore.getState().details['card-a']?.card).toBe(newer);
  expect(useCardStore.getState()).toMatchObject({ seq: 5, rowSeq: { 'card-a': 5, 'card-b': 3 } });
});

test('목록 snapshot에 없던 행은 snapshot 이후 쓰인 경우에만 병합한다', () => {
  const before = cardFixture({ id: 'before' });
  const after = cardFixture({ id: 'after' });
  const updates = { before, after };

  expect(mergeCardRows([], updates, { seq: 1, rowSeq: { before: 1, after: 2 } }).map((row) => row.id))
    .toEqual(['after']);
  expect(mergeCardRows([], updates).map((row) => row.id)).toEqual(['before', 'after']);
});
