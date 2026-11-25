import type { CardComment, CardDetail, CardDto, CardQuestion } from '../../api/cardTypes';
import type { PersistentReportEntry } from '../../../../packages/wire-schema/src/persistent_report';
import { cardFixture } from '../../test-support/cards';
import {
  buildThread, cardAgenda, entryAgenda, formatReturnTime, groupAgendas, itemInstructionBody, nextSnoozeReturn, openQuestionOf,
  snoozeOptions, summarizeTechnicalNotes,
} from '../pas-report-thread-model';

const card = (patch: Partial<CardDto> & { id: string }): CardDto => cardFixture({
  number: 1, status: 'review', createdAt: '2026-11-25T01:00:00.000Z', updatedAt: '2026-11-25T02:00:00.000Z',
  assigneeKind: 'session', assigneeSessionId: 's-main', ...patch,
});
const entry = (patch: Partial<PersistentReportEntry> & { key: string }): PersistentReportEntry => ({
  kind: 'see', title: '장 제목', card_numbers: [7], context: '', action: '', options: [], state: 'open', answer: '',
  updated_at: '2026-11-25T02:00:00.000Z', card_id: 'c1', card_status: 'review', ...patch,
}) as PersistentReportEntry;
const comment = (patch: Partial<CardComment> & { id: string; createdAt: string }): CardComment => ({
  cardId: 'c1', authorKind: 'user', authorId: 'u', sessionId: null, kind: 'comment', body: '글', ...patch,
});

describe('entryAgenda', () => {
  it('판의 장을 데이터로 종류를 가른다', () => {
    expect(entryAgenda(entry({ key: 'cq_a', question_kind: 'choice' }), undefined)?.kind).toBe('question');
    expect(entryAgenda(entry({ key: 'cq_a', question_kind: 'request' }), undefined)?.kind).toBe('request');
    expect(entryAgenda(entry({ key: 'card_c1' }), card({ id: 'c1', status: 'review' }))?.kind).toBe('review');
    expect(entryAgenda(entry({ key: 'card_c1', card_status: 'blocked' }), undefined)?.kind).toBe('blocked');
    expect(entryAgenda(entry({ key: 'card_c1' }), card({ id: 'c1', status: 'awaiting_verification' }))?.kind).toBe('verifying');
  });
  it('card_id가 없는 PAS 자체 장과 답한 질문 장, 끝난 카드는 안건이 아니다', () => {
    expect(entryAgenda(entry({ key: 'x', card_id: undefined }), undefined)).toBeNull();
    expect(entryAgenda(entry({ key: 'cq_a', state: 'answered' }), undefined)).toBeNull();
    expect(entryAgenda(entry({ key: 'card_c1' }), card({ id: 'c1', status: 'done' }))).toBeNull();
  });
  it('카드의 snoozedUntil을 읽고, 없는 응답과 깨진 값에서도 깨지지 않는다', () => {
    expect(entryAgenda(entry({ key: 'card_c1' }), card({ id: 'c1', snoozedUntil: '2026-11-26T00:00:00.000Z' }))?.snoozedUntil)
      .toBe(Date.parse('2026-11-26T00:00:00.000Z'));
    expect(entryAgenda(entry({ key: 'card_c1' }), card({ id: 'c1' }))?.snoozedUntil).toBeNull();
    expect(entryAgenda(entry({ key: 'card_c1' }), card({ id: 'c1', snoozedUntil: '아님' }))?.snoozedUntil).toBeNull();
  });
});

describe('groupAgendas', () => {
  const now = Date.parse('2026-11-25T12:00:00.000Z');
  const board = [
    entryAgenda(entry({ key: 'card_a', card_id: 'a' }), card({ id: 'a', number: 1 }))!,
    entryAgenda(entry({ key: 'card_b', card_id: 'b' }), card({ id: 'b', number: 2, snoozedUntil: '2026-11-25T15:00:00.000Z' }))!,
    entryAgenda(entry({ key: 'card_c', card_id: 'c' }), card({ id: 'c', number: 3, snoozedUntil: '2026-11-25T11:00:00.000Z' }))!,
  ];
  const cards = [
    card({ id: 'a', status: 'review' }), card({ id: 'r1', status: 'running', updatedAt: '2026-11-25T03:00:00.000Z' }),
    card({ id: 'r2', status: 'awaiting_verification', updatedAt: '2026-11-25T05:00:00.000Z' }), card({ id: 'r3', status: 'queued' }),
    card({ id: 'h1', status: 'on_hold' }), card({ id: 'h2', status: 'on_hold' }),
  ];
  const groups = groupAgendas(board, cards, now);
  it('미룬 것만 미뤄 둠으로 가고, 미룬 시각이 지난 것은 결재 대기로 돌아온다', () => {
    expect(groups.snoozed.map(agenda => agenda.cardId)).toEqual(['b']);
    expect(groups.pending.map(agenda => agenda.cardId)).toEqual(['a', 'c']);
  });
  it('진행 중은 running과 검증 대기 가운데 결재 대기에 없는 것을 최근 갱신 순으로 둔다', () => {
    expect(groups.running.map(agenda => [agenda.cardId, agenda.kind])).toEqual([['r2', 'verifying'], ['r1', 'running']]);
  });
  it('보류함 개수는 on_hold 카드 수다', () => {
    expect(groups.holdCount).toBe(2);
  });
  it('같은 카드가 두 장으로 와도 한 번만 센다', () => {
    const twice = groupAgendas([...board, board[0]], cards, now);
    expect(twice.pending.map(agenda => agenda.cardId)).toEqual(['a', 'c']);
  });
  it('다음에 돌아올 시각을 알려 준다', () => {
    expect(nextSnoozeReturn(board, now)).toBe(Date.parse('2026-11-25T15:00:00.000Z'));
    expect(nextSnoozeReturn(board, Date.parse('2026-11-25T16:00:00.000Z'))).toBeNull();
  });
  it('진행 중이 아닌 카드는 안건이 되지 않는다', () => {
    expect(cardAgenda(card({ id: 'q', status: 'queued' }))).toBeNull();
  });
});

describe('snoozeOptions', () => {
  it('지금이 18시 전이면 네 선택지를 기기 지역 시각으로 낸다', () => {
    const now = new Date(2026, 10, 25, 10, 30);
    const options = snoozeOptions(now);
    expect(options.map(option => option.label)).toEqual(['1시간 뒤', '오늘 저녁', '내일 아침', '사흘 뒤']);
    expect(options.map(option => new Date(option.at))).toEqual([
      new Date(2026, 10, 25, 11, 30), new Date(2026, 10, 25, 19, 0), new Date(2026, 10, 26, 9, 0), new Date(2026, 10, 28, 9, 0)]);
  });
  it('오늘 저녁은 18시 정각부터 뺀다(17:59는 있고 18:00부터 없다)', () => {
    expect(snoozeOptions(new Date(2026, 10, 25, 17, 59)).map(option => option.label)).toContain('오늘 저녁');
    expect(snoozeOptions(new Date(2026, 10, 25, 18, 0)).map(option => option.label)).toEqual(['1시간 뒤', '내일 아침', '사흘 뒤']);
    expect(snoozeOptions(new Date(2026, 10, 25, 18, 5)).map(option => option.label)).toEqual(['1시간 뒤', '내일 아침', '사흘 뒤']);
  });
  it('모든 선택지가 지금보다 뒤이고 30일 안이다', () => {
    const now = new Date(2026, 10, 25, 23, 50);
    for (const option of snoozeOptions(now)) {
      expect(option.at).toBeGreaterThan(now.getTime());
      expect(option.at - now.getTime()).toBeLessThan(30 * 86_400_000);
    }
  });
});

describe('formatReturnTime', () => {
  const now = new Date(2026, 10, 25, 10, 0).getTime();
  it('오늘은 시각, 내일은 「내일」, 그 뒤는 월/일을 붙인다', () => {
    expect(formatReturnTime(new Date(2026, 10, 25, 19, 0).getTime(), now)).toBe('19:00');
    expect(formatReturnTime(new Date(2026, 10, 26, 9, 5).getTime(), now)).toBe('내일 09:05');
    expect(formatReturnTime(new Date(2026, 10, 28, 9, 0).getTime(), now)).toBe('11/28 09:00');
  });
});

describe('buildThread', () => {
  const question: CardQuestion = { id: 'q1', cardId: 'c1', sessionId: 's-main', text: '어느 쪽?', options: ['가', '나'], answer: null, askedAt: '2026-11-25T03:00:00.000Z' };
  const detail = (patch: Partial<CardDetail> = {}): CardDetail => ({
    card: card({ id: 'c1' }), reports: [], questions: [], sessions: [], comments: [], notes: [], nowHistory: [], ...patch,
  });
  const session = (id: string, agentId: string, createdAt: string, agentName?: string) =>
    ({ agentSessionId: id, agentId, agentName, displayName: null, status: 'running', createdAt, updatedAt: createdAt }) as unknown as CardDetail['sessions'][number];
  it('원 요청, 이정표, 커멘트를 시간순으로 한 줄기에 둔다', () => {
    const thread = buildThread(detail({
      nowHistory: [{ text: '조사 중', turn: 'agent', ask: null, at: '2026-11-25T01:30:00.000Z' }],
      statusHistory: [{ status: 'review', at: '2026-11-25T01:45:00.000Z', actorKind: 'agent', sessionId: 's-main' }],
      sessions: [session('s-main', 'roselin', '2026-11-25T01:10:00.000Z'), session('s-sub', 'selaphiel', '2026-11-25T01:20:00.000Z', '세라피엘')],
      comments: [comment({ id: 'm1', createdAt: '2026-11-25T01:50:00.000Z' })],
    }));
    expect(thread.map(item => item.kind === 'milestone' ? `milestone:${item.text}` : item.kind)).toEqual([
      'request', 'milestone:위임: 세라피엘', 'milestone:조사 중', 'milestone:상태: 검수 대기', 'comments',
    ]);
  });
  it('statusHistory가 없는 응답은 그 이정표만 뺀다', () => {
    const thread = buildThread(detail({ nowHistory: [{ text: '조사 중', turn: 'agent', ask: null, at: '2026-11-25T01:30:00.000Z' }] }));
    expect(thread.filter(item => item.kind === 'milestone')).toHaveLength(1);
  });
  it('기술 기록(노트)은 이어진 것끼리 한 덩이로 접고, 사이에 커멘트가 끼면 나눈다', () => {
    const thread = buildThread(detail({ comments: [
      comment({ id: 'n1', createdAt: '2026-11-25T02:00:00.000Z', kind: 'note', authorKind: 'agent' }),
      comment({ id: 'n2', createdAt: '2026-11-25T02:01:00.000Z', kind: 'note', authorKind: 'agent' }),
      comment({ id: 'm1', createdAt: '2026-11-25T02:02:00.000Z' }),
      comment({ id: 'n3', createdAt: '2026-11-25T02:03:00.000Z', kind: 'note', authorKind: 'agent' }),
    ] }));
    expect(thread.map(item => item.kind === 'notes' ? `notes:${item.notes.length}` : item.kind)).toEqual(['request', 'notes:2', 'comments', 'notes:1']);
  });
  it('기술 기록 줄 글은 건수만 말한다', () => {
    expect(summarizeTechnicalNotes(3)).toBe('기술 기록 3건');
  });
  it('질문 글타래의 커멘트는 질문 블록에 두고 따로 세우지 않는다', () => {
    const thread = buildThread(detail({ questions: [question], comments: [comment({ id: 't1', createdAt: '2026-11-25T03:05:00.000Z', questionId: 'q1' })] }));
    expect(thread.map(item => item.kind)).toEqual(['request', 'question']);
  });
  it('같은 상황판 문구는 한 번만 둔다', () => {
    const same = { text: '같음', turn: 'agent' as const, ask: null, at: '2026-11-25T01:30:00.000Z' };
    expect(buildThread(detail({ nowHistory: [same, same] })).filter(item => item.kind === 'milestone')).toHaveLength(1);
  });
});

describe('질문과 항목 지시', () => {
  const open: CardQuestion = { id: 'q1', cardId: 'c1', sessionId: 's', text: '?', options: null, answer: null, askedAt: 't' };
  it('열린 질문을 찾고, 답한 질문과 철회된 질문은 열린 것으로 치지 않는다', () => {
    const answered: CardQuestion = { ...open, id: 'q0', answer: '응' };
    const withdrawn: CardQuestion = { ...open, id: 'q2', withdrawnAt: '2026-11-25T04:00:00.000Z' };
    const detail = { card: card({ id: 'c1' }), reports: [], questions: [answered, withdrawn, open], sessions: [] } as CardDetail;
    expect(openQuestionOf(detail, null)?.id).toBe('q1');
    expect(openQuestionOf(undefined, null)).toBeNull();
  });
  it('여러 질문이 열려 있으면 판의 질문 장에 맞는 것을 고른다', () => {
    const second: CardQuestion = { ...open, id: 'q2' };
    const detail = { card: card({ id: 'c1' }), reports: [], questions: [open, second], sessions: [] } as CardDetail;
    expect(openQuestionOf(detail, entry({ key: 'cq_q2', question_id: 'q2' }))?.id).toBe('q2');
  });
  it('질문이 열려 있을 때 항목 지시는 글 앞에 번호를 적는다', () => {
    expect(itemInstructionBody(3, '다시 확인해줘')).toBe('3번 항목: 다시 확인해줘');
  });
});
