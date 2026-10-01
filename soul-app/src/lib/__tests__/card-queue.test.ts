import { queueAfterCardId, cardPrimaryAction } from '../card-presentation';

test('드롭 위치를 실제 행 높이로 계산하고 맨 앞·끝을 서버 afterCardId로 바꾼다', () => {
  const layouts = [ { id: 'a', top: 0, height: 64 }, { id: 'b', top: 64, height: 96 }, { id: 'c', top: 160, height: 64 } ];
  expect(queueAfterCardId('c', 0, layouts)).toBeNull();
  expect(queueAfterCardId('a', 250, layouts)).toBe('c');
  expect(queueAfterCardId('c', 90, layouts)).toBe('a');
});
test('검수·열린 질문·막힘·할 일·대기열의 주 동작이 상태와 맞는다', () => {
  expect(cardPrimaryAction({ status: 'review', blockedKind: null })).toBe('review');
  expect(cardPrimaryAction({ status: 'blocked', blockedKind: 'question' })).toBe('answer');
  expect(cardPrimaryAction({ status: 'blocked', blockedKind: 'no_report' })).toBe('queue');
  expect(cardPrimaryAction({ status: 'todo', blockedKind: null })).toBe('queue');
  expect(cardPrimaryAction({ status: 'queued', blockedKind: null })).toBe('remove');
  expect(cardPrimaryAction({ status: 'running', blockedKind: null })).toBeNull();
});
