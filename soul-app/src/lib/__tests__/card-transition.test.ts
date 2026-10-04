import { cardFixture } from '../../test-support/cards';
import type { CardDetail } from '../../api/cardTypes';
import {useAuthStore} from '../../store/authStore';
import {ApiHttpError} from '../../api/clientCore';
import { cardExecutionState, cardTransitionProblem, performCardTransition } from '../card-transition';

const detail = (overrides: Partial<CardDetail> = {}): CardDetail => ({ card: cardFixture(), reports: [], questions: [], sessions: [], ...overrides });

test('보고 없이 보관·완료 카드도 사유 없이 이동한다', () => {
  const archived = detail({ card: cardFixture({ status: 'done', archived: true }) });
  for (const next of ['todo', 'queued', 'running', 'blocked', 'review', 'cancelled'] as const)
    expect(cardTransitionProblem(archived, next)).toBeNull();
  expect(cardTransitionProblem(detail({card:cardFixture({status:'review'})}), 'running')).toBeNull();
});

test.each(['todo', 'queued', 'running', 'review', 'done', 'cancelled'] as const)('미답 질문이 있어도 %s 상태를 저장한다', async (next) => {
  const source = cardFixture({ status: 'blocked', blockedKind: 'question' });
  const latest = detail({ card: source, reports: [], questions: [{ answer: null } as any] });
  const api = { getCard: jest.fn().mockResolvedValue(latest), setCardStatus: jest.fn().mockResolvedValue({ card: { ...source, status: next } }),executeCard:jest.fn().mockResolvedValue({card:{...source,status:next},execution:{requestId:'req',state:'started'}}) };
  expect(cardTransitionProblem(latest, next)).toBeNull();
  await performCardTransition(api as any, source, next, `question-${next}`);
  if(next==='running')expect(api.executeCard).toHaveBeenCalledWith(source.id,source.version,`question-${next}`);
  else expect(api.setCardStatus).toHaveBeenCalledWith(source.id, next, source.version, `question-${next}`, undefined);
});

test('명시 조작 때 최신 버전으로 저장하고 중복 호출은 쓰지 않는다', async () => {
  let finish!: (value: any) => void;
  const api = { getCard: jest.fn().mockResolvedValue(detail({ card: cardFixture({ version: 7 }) })),
    setCardStatus: jest.fn(() => new Promise((resolve) => { finish = resolve; })) };
  const first = performCardTransition(api as any, cardFixture(), 'queued', 'operation');
  await Promise.resolve();
  await expect(performCardTransition({ ...api } as any, cardFixture(), 'queued', 'duplicate')).rejects.toThrow('저장 중');
  await expect(performCardTransition(api as any, cardFixture(), 'running', 'different-intent')).rejects.toThrow('저장 중');
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


test('running intent is available even when status is running',()=>{
  expect(cardTransitionProblem(detail({card:cardFixture({status:'running'})}),'running')).toBeNull();
});


test('pending is accepted and later observes the same request without another POST',async()=>{
 jest.useFakeTimers();
 const source=cardFixture({id:'pending-start',status:'todo',assigneeSessionId:'owner'});
 const accepted={card:{...source,status:'running',version:2},execution:{requestId:'fixed-request',sessionId:'owner',state:'pending'}};
 const api={getCard:jest.fn().mockResolvedValue(detail({card:source})),executeCard:jest.fn().mockResolvedValue(accepted),getCardExecution:jest.fn().mockResolvedValue({...accepted,execution:{...accepted.execution,state:'started'}})};
 await expect(performCardTransition(api as any,source,'running','first')).resolves.toEqual(accepted);
 await jest.advanceTimersByTimeAsync(1000);
 expect(api.executeCard).toHaveBeenCalledTimes(1);expect(api.getCardExecution).toHaveBeenCalledWith(source.id,'fixed-request');
 jest.useRealTimers();
});

test('thirty-second delay checks the same request again, while auth changes stop observation',async()=>{
 jest.useFakeTimers();
 const source=cardFixture({id:'delayed-app',assigneeSessionId:'owner'});
 const result={card:source,execution:{requestId:'delay-request',sessionId:'owner',state:'pending'}};
 const api={getCard:jest.fn().mockResolvedValue(detail({card:source})),executeCard:jest.fn().mockResolvedValue(result),getCardExecution:jest.fn().mockResolvedValue(result)};
 await performCardTransition(api as any,source,'running','first');await jest.advanceTimersByTimeAsync(30000);
 expect(cardExecutionState(source.id)?.phase).toBe('delayed');
 await performCardTransition(api as any,source,'running','confirm');expect(api.executeCard).toHaveBeenCalledTimes(1);expect(api.getCardExecution).toHaveBeenLastCalledWith(source.id,'delay-request');
 useAuthStore.setState({jwt:'changed-auth'});const count=api.getCardExecution.mock.calls.length;
 await jest.advanceTimersByTimeAsync(30000);expect(api.getCardExecution).toHaveBeenCalledTimes(count);expect(cardExecutionState(source.id)).toBeUndefined();jest.useRealTimers();
});
test('a real execution failure stops observation with an everyday reason',async()=>{
 jest.useFakeTimers();
 const source=cardFixture({id:'failed-app',assigneeSessionId:'owner'});
 const result={card:source,execution:{requestId:'fail-request',sessionId:'owner',state:'pending'}};
 const api={getCard:jest.fn().mockResolvedValue(detail({card:source})),executeCard:jest.fn().mockResolvedValue(result),getCardExecution:jest.fn().mockRejectedValue(new ApiHttpError('internal idempotency delivery',422,''))};
 await performCardTransition(api as any,source,'running','first');await jest.advanceTimersByTimeAsync(1000);
 expect(cardExecutionState(source.id)).toMatchObject({phase:'error',message:'카드를 시작하지 못했습니다. 다시 시도해 주세요.'});
 await jest.advanceTimersByTimeAsync(30000);expect(api.getCardExecution).toHaveBeenCalledTimes(1);jest.useRealTimers();
});
