import { cardFixture } from '../../test-support/cards';
import { groupPersistentSessionTasks } from '../persistent-session-tasks';

test('작업 목록은 여섯 활성 상태만 보드 순서와 보드 라벨로 묶는다', () => {
  const cards = [
    cardFixture({ id: 'todo', status: 'todo' }),
    cardFixture({ id: 'queued', status: 'queued' }),
    cardFixture({ id: 'review', status: 'review' }),
    cardFixture({ id: 'running', status: 'running' }),
    cardFixture({ id: 'blocked', status: 'blocked' }),
    cardFixture({ id: 'awaiting', status: 'awaiting_verification' }),
    cardFixture({ id: 'done', status: 'done' }),
    cardFixture({ id: 'cancelled', status: 'cancelled' }),
  ];

  expect(groupPersistentSessionTasks(cards).map(({ status, label }) => [status, label])).toEqual([
    ['running', '실행 중'],
    ['blocked', '막힘'],
    ['awaiting_verification', '검증 대기'],
    ['review', '검수 대기'],
    ['queued', '대기'],
    ['todo', '드래프트'],
  ]);
  expect(groupPersistentSessionTasks(cards).flatMap((group) => group.cards.map((card) => card.id))).toEqual([
    'running', 'blocked', 'awaiting', 'review', 'queued', 'todo',
  ]);
});

test('그룹 안은 queued만 queuePositionKey 오름차순, 나머지는 상태 변경 시각 내림차순이다', () => {
  const at = (day: string) => `2026-10-${day}T00:00:00Z`;
  const cards = [
    cardFixture({ id: 'todo-old', status: 'todo', positionKey: 'a', statusChangedAt: at('01') }),
    cardFixture({ id: 'todo-new', status: 'todo', positionKey: 'b', statusChangedAt: at('05') }),
    cardFixture({ id: 'queued-b', status: 'queued', positionKey: 'a', queuePositionKey: 'b', statusChangedAt: at('09') }),
    cardFixture({ id: 'queued-a', status: 'queued', positionKey: 'z', queuePositionKey: 'a', statusChangedAt: at('02') }),
    cardFixture({ id: 'running-old', status: 'running', positionKey: 'a', statusChangedAt: at('03') }),
    cardFixture({ id: 'running-new', status: 'running', positionKey: 'b', statusChangedAt: at('04') }),
  ];

  const groups = groupPersistentSessionTasks(cards);
  expect(groups.find((group) => group.status === 'running')?.cards.map((card) => card.id)).toEqual(['running-new', 'running-old']);
  expect(groups.find((group) => group.status === 'queued')?.cards.map((card) => card.id)).toEqual(['queued-a', 'queued-b']);
  expect(groups.find((group) => group.status === 'todo')?.cards.map((card) => card.id)).toEqual(['todo-new', 'todo-old']);
});

test('빈 그룹은 결과에서 생략된다', () => {
  expect(groupPersistentSessionTasks([])).toEqual([]);
  expect(groupPersistentSessionTasks([cardFixture({ status: 'cancelled' })])).toEqual([]);
});
