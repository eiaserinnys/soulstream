import { cardFixture } from '../../test-support/cards';
import { groupPersistentSessionTasks } from '../persistent-session-tasks';

test('작업 목록은 다섯 활성 상태만 보드 순서와 보드 라벨로 묶는다', () => {
  const cards = [
    cardFixture({ id: 'todo', status: 'todo' }),
    cardFixture({ id: 'queued', status: 'queued' }),
    cardFixture({ id: 'review', status: 'review' }),
    cardFixture({ id: 'running', status: 'running' }),
    cardFixture({ id: 'blocked', status: 'blocked' }),
    cardFixture({ id: 'done', status: 'done' }),
    cardFixture({ id: 'cancelled', status: 'cancelled' }),
  ];

  expect(groupPersistentSessionTasks(cards).map(({ status, label }) => [status, label])).toEqual([
    ['running', '실행 중'],
    ['blocked', '막힘'],
    ['review', '검수 대기'],
    ['queued', '대기'],
    ['todo', '드래프트'],
  ]);
  expect(groupPersistentSessionTasks(cards).flatMap((group) => group.cards.map((card) => card.id))).toEqual([
    'running', 'blocked', 'review', 'queued', 'todo',
  ]);
});

test('그룹 안은 queued positionKey, 나머지 positionKey의 사전식 순서다', () => {
  const cards = [
    cardFixture({ id: 'todo-b', status: 'todo', positionKey: 'b' }),
    cardFixture({ id: 'todo-a', status: 'todo', positionKey: 'a' }),
    cardFixture({ id: 'queued-b', status: 'queued', positionKey: 'a', queuePositionKey: 'b' }),
    cardFixture({ id: 'queued-a', status: 'queued', positionKey: 'z', queuePositionKey: 'a' }),
    cardFixture({ id: 'running-b', status: 'running', positionKey: 'b' }),
    cardFixture({ id: 'running-a', status: 'running', positionKey: 'a' }),
  ];

  const groups = groupPersistentSessionTasks(cards);
  expect(groups.find((group) => group.status === 'running')?.cards.map((card) => card.id)).toEqual(['running-a', 'running-b']);
  expect(groups.find((group) => group.status === 'queued')?.cards.map((card) => card.id)).toEqual(['queued-a', 'queued-b']);
  expect(groups.find((group) => group.status === 'todo')?.cards.map((card) => card.id)).toEqual(['todo-a', 'todo-b']);
});

test('빈 그룹은 결과에서 생략된다', () => {
  expect(groupPersistentSessionTasks([])).toEqual([]);
  expect(groupPersistentSessionTasks([cardFixture({ status: 'cancelled' })])).toEqual([]);
});
