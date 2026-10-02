import { cardFixture } from '../../test-support/cards';
import type { CardDetail } from '../../api/cardTypes';
import { cardTransitionProblem, performCardTransition } from '../card-transition';

const detail = (overrides: Partial<CardDetail> = {}): CardDetail => ({ card: cardFixture(), reports: [], questions: [], sessions: [], ...overrides });

test('보고·재실행 사유와 지원하지 않는 막힘 전이를 표시한다', () => {
  expect(cardTransitionProblem(detail(), 'review')).toMatch('보고');
  expect(cardTransitionProblem(detail({ card: cardFixture({ status: 'review' }) }), 'running')).toMatch('사유');
  expect(cardTransitionProblem(detail(), 'blocked')).toMatch('질문');
  expect(cardTransitionProblem(detail(), 'queued')).toBeNull();
  expect(cardTransitionProblem(detail({ card: cardFixture({ status: 'review' }) }), 'done')).toBeNull();
});

test.each(['todo', 'queued', 'running', 'review', 'done', 'cancelled'] as const)('미답 질문이 있어도 %s 상태를 저장한다', async (next) => {
  const source = cardFixture({ status: 'blocked', blockedKind: 'question' });
  const latest = detail({ card: source, reports: [{ id: 'report' } as any], questions: [{ answer: null } as any] });
  const api = { getCard: jest.fn().mockResolvedValue(latest), setCardStatus: jest.fn().mockResolvedValue({ card: { ...source, status: next } }) };
  expect(cardTransitionProblem(latest, next)).toBeNull();
  await performCardTransition(api as any, source, next, `question-${next}`);
  expect(api.setCardStatus).toHaveBeenCalledWith(source.id, next, source.version, `question-${next}`, undefined);
});

test('명시 조작 때 최신 버전으로 저장하고 중복 호출은 쓰지 않는다', async () => {
  let finish!: (value: any) => void;
  const api = { getCard: jest.fn().mockResolvedValue(detail({ card: cardFixture({ version: 7 }) })),
    setCardStatus: jest.fn(() => new Promise((resolve) => { finish = resolve; })) };
  const first = performCardTransition(api as any, cardFixture(), 'queued', 'operation');
  await Promise.resolve();
  await expect(performCardTransition({ ...api } as any, cardFixture(), 'queued', 'duplicate')).rejects.toThrow('저장 중');
  expect(api.setCardStatus).toHaveBeenCalledWith('card-1', 'queued', 7, 'operation', undefined);
  finish({ card: cardFixture({ version: 8, status: 'queued' }), folderId: 'folder-1' });
  await first;
});

test('취소·unmount 뒤 늦게 도착한 상세는 쓰지 않는다', async () => {
  let resolve!: (value: CardDetail) => void;
  const api = { getCard: jest.fn(() => new Promise<CardDetail>((finish) => { resolve = finish; })), setCardStatus: jest.fn() };
  let active = true;
  const pending = performCardTransition(api as any, cardFixture(), 'queued', 'late', undefined, () => active);
  active = false; resolve(detail());
  await expect(pending).rejects.toThrow('취소');
  expect(api.setCardStatus).not.toHaveBeenCalled();
});

test('변경된 출발 상태는 write를 막고 실패 뒤 다시 시도할 수 있다', async () => {
  const api = { getCard: jest.fn().mockResolvedValue(detail({ card: cardFixture({ status: 'running' }) })), setCardStatus: jest.fn() };
  await expect(performCardTransition(api as any, cardFixture(), 'queued', 'a')).rejects.toThrow('상태가 바뀌');
  expect(api.setCardStatus).not.toHaveBeenCalled();
  api.getCard.mockResolvedValue(detail());
  api.setCardStatus.mockRejectedValueOnce(new Error('저장 실패')).mockResolvedValue({ card: cardFixture({ status: 'queued' }) });
  await expect(performCardTransition(api as any, cardFixture(), 'queued', 'b')).rejects.toThrow('저장 실패');
  await expect(performCardTransition(api as any, cardFixture(), 'queued', 'c')).resolves.toHaveProperty('card.status', 'queued');
});
