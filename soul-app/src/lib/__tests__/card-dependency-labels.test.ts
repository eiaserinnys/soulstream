import { CARD_BOARD_STATUS_LABELS } from '../../../../packages/soul-ui/src/lib/card-board-status-labels';
import type { CardDependency } from '../../../../packages/wire-schema/src/card_dependency_display';
import { cardDependencyStartMessage, cardDependencyStatus } from '../card-transition';

const dep = (overrides: Partial<CardDependency>): CardDependency => ({
  id: 'dep', number: 1, title: '선행', status: 'running', archived: false, met: false, ...overrides });

test('todo 선행은 웹과 같이 드래프트이고 나머지 라벨은 웹 보드 라벨 그대로다', () => {
  expect(cardDependencyStatus(dep({ status: 'todo' }))).toEqual({ label: '드래프트', tone: 'neutral' });
  for (const status of ['queued', 'running', 'review', 'done', 'cancelled'] as const)
    expect(cardDependencyStatus(dep({ status })).label).toBe(CARD_BOARD_STATUS_LABELS[status]);
  expect(cardDependencyStatus(dep({ status: 'todo', archived: true }))).toEqual({ label: '보관됨', tone: 'error' });
});

test('시작 확인 본문에서 todo 선행은 #N(드래프트)로 적힌다', () => {
  const dependsOn = [dep({ number: 1864, status: 'running' }), dep({ id: 'b', number: 1863, status: 'todo' }),
    dep({ id: 'c', number: 1862, status: 'done', met: true })];
  expect(cardDependencyStartMessage({ dependsOn })).toBe('#1864(실행 중), #1863(드래프트)이 아직 충족되지 않았습니다. 기다리지 않고 지금 시작할까요?');
});
