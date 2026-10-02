import { describe, expect, it, vi } from 'vitest';
import { buildObservationInput, selectObservationCards, evaluateCardObservation } from '../src/cards/jev_card_observation.js';

const card = (id = 'a', status = 'blocked') => ({ id, title: `카드 ${id}`, status, request: '화면을 고쳐주세요', brief: '', instruction: '', report: '', version: 3 });
const history = [
  { id: 1, type: 'user_message', text: '화면을 고쳐주세요' },
  { id: 2, type: 'assistant_message', text: '구현 세션에 맡겼습니다. 결과를 기다립니다.' },
  { id: 3, type: 'tool_result', text: 'SECRET_TOOL_OUTPUT' },
  { id: 4, type: 'debug', text: 'previous observation complete' },
  { id: 20, type: 'assistant_message', text: 'FUTURE_TURN' },
];
function input() { return buildObservationInput({ completeEventId: 10, cards: [card()], history, summaries: [], startObservations: [], totalCards: 1 }); }
const answer = (choice: string) => ({ type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 1 });

describe('Jev card observation contract', () => {
  it('sends only canonical text through the cutoff, and marks absent actual start snapshot', () => {
    const built = input();
    expect(built.scope.actualStartSnapshot).toBe('unavailable');
    expect(JSON.stringify(built)).not.toMatch(/SECRET_TOOL_OUTPUT|FUTURE_TURN|previous observation/);
    expect(built.history).toHaveLength(2);
  });
  it('uses owned start/end/this turn operation union, capped before detail reads', () => {
    const selected = selectObservationCards({ startIds: ['b', 'a'], endIds: ['a', 'c'], operationIds: ['d'], limit: 2 });
    expect(selected).toEqual({ ids: ['a', 'b'], total: 4, omitted: 2 });
  });
  it('bounds history and ignores summaries whose source extends past completion', () => {
    const built = buildObservationInput({ completeEventId: 10, cards: [card()], history: [{ id: 1, type: 'assistant_message', text: '가'.repeat(100_000) }], summaries: [{ id: 5, throughEventId: 21, text: 'FUTURE_SUMMARY' }], startObservations: [], totalCards: 1 });
    expect(built.scope.truncated).toBe(true);
    expect(JSON.stringify(built).length).toBeLessThan(25_000);
    expect(JSON.stringify(built)).not.toContain('FUTURE_SUMMARY');
  });
  it('makes no call for card zero or unavailable credential', async () => {
    const fetcher = vi.fn();
    await evaluateCardObservation({ ...input(), cards: [] }, 'key', { fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    const outcome = await evaluateCardObservation(input(), null, { fetcher });
    expect(outcome.status).toBe('not_evaluated');
    expect(outcome.calls).toBe(0);
  });
  it('omits recognizable credentials even when they appear in canonical text',()=>{
    const built=buildObservationInput({completeEventId:10,cards:[card()],history:[{id:1,type:'user_message',text:'TYPESAFE_API_KEY=private-value Authorization: Bearer private.token.value'}],summaries:[],startObservations:[],totalCards:1});
    expect(JSON.stringify(built)).not.toContain('private-value');
    expect(JSON.stringify(built)).not.toContain('private.token.value');
  });
  it.each(['waiting', 'blocked', 'in_progress', 'unrelated', 'unknown'])('maps %s from the provider, never from stored status', async choice => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { c0: answer(choice) }, usage: { input_tokens: 45, output_tokens: 12 } })));
    const outcome = await evaluateCardObservation(input(), 'key', { fetcher });
    expect(outcome.cards[0]!.classification).toBe(choice);
    expect(outcome.cards[0]!.storedStatus).toBe('blocked');
    expect(outcome.calls).toBe(1);
  });
  it('withholds completion when actual start/ending scope is unverified', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ answers: { c0: answer('ready_for_review') } })));
    const outcome = await evaluateCardObservation(input(), 'key', { fetcher });
    expect(outcome.cards[0]!.classification).toBe('unknown');
    expect(outcome.cards[0]!.providerChoice).toBe('ready_for_review');
    expect(outcome.cards[0]!.completionWithheld).toBe(true);
  });
  it('maps multiple cards to one request and treats missing outputs as errors', async () => {
    const built = { ...input(), cards: [card('a'), card('b')] };
    const fetcher = vi.fn(async (_url, options) => {
      const payload = JSON.parse(String(options?.body));
      expect(Object.keys(payload.questions)).toEqual(['c0', 'c1']);
      expect(payload.questions.c0.type).toBe('choice');
      expect(JSON.stringify(payload)).toContain('위임');
      return new Response(JSON.stringify({ answers: { c0: answer('waiting'), c1: answer('blocked') } }));
    });
    const outcome = await evaluateCardObservation(built, 'key', { fetcher });
    expect(outcome.cards.map(c => c.cardId)).toEqual(['a', 'b']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const error = await evaluateCardObservation(built, 'key', { fetcher: async () => new Response('{}') });
    expect(error.status).toBe('not_evaluated');
    expect(error.reason).toBe('invalid_response');
  });
  it('contains timeouts/errors without retry or affecting the final answer', async () => {
    const fetcher = vi.fn(async () => { throw new Error('secret credential'); });
    const result = await evaluateCardObservation(input(), 'key', { fetcher });
    expect(result.reason).toBe('error');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('secret credential');
    const signal = AbortSignal.abort(new DOMException('timeout', 'TimeoutError'));
    const timeout = await evaluateCardObservation(input(), 'key', { fetcher, signal });
    expect(timeout.reason).toBe('timeout');
  });
});
