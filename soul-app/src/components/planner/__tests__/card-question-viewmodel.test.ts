import type { CardComment, CardQuestion } from '../../../api/cardTypes';
import type { PersistentReportEntry } from '../../../api/types';
import { cardQuestionViewFromDetail, cardQuestionViewFromEntry } from '../card-question-viewmodel';

function question(overrides: Partial<CardQuestion> = {}): CardQuestion {
  return {
    id: 'q1',
    cardId: 'card-1',
    sessionId: 'sess-1',
    text: '배경 전문',
    options: null,
    answer: null,
    askedAt: '2026-11-12T10:00:00Z',
    ...overrides,
  };
}

function comment(overrides: Partial<CardComment> = {}): CardComment {
  return {
    id: 'c1',
    cardId: 'card-1',
    authorKind: 'user',
    authorId: null,
    sessionId: null,
    kind: 'comment',
    body: '글',
    createdAt: '2026-11-12T10:01:00Z',
    questionId: 'q1',
    ...overrides,
  };
}

function entry(overrides: Partial<PersistentReportEntry> = {}): PersistentReportEntry {
  return {
    key: 'cq_q1',
    kind: 'ask',
    title: '카드 제목 24자',
    card_numbers: [1197],
    context: '옛 장 배경',
    action: '',
    options: [],
    state: 'open',
    answer: '',
    updated_at: '2026-11-12T10:00:00Z',
    ...overrides,
  };
}

describe('cardQuestionViewFromDetail', () => {
  it('옛 질문은 제목이 없고 이름표만 있는 선택지를 쓴다', () => {
    const view = cardQuestionViewFromDetail(
      question({ options: ['파랑', '빨강'], answer: '파랑', answeredAt: '2026-11-12T10:05:00Z' }),
      [],
      '카드 제목',
    );
    expect(view).toEqual({
      id: 'q1',
      title: null,
      background: '배경 전문',
      kind: 'choice',
      options: [
        { label: '파랑', description: null, recommended: false },
        { label: '빨강', description: null, recommended: false },
      ],
      attachments: [],
      thread: [],
      open: false,
      selectedOption: '파랑',
      answer: '파랑',
      revisedAt: null,
      awaitingAgent: false,
    });
  });

  it('새 선택 질문은 optionDetails의 설명과 권함을 보존한다', () => {
    const attachment = { type: 'image' as const, label: '그림', url: 'https://example.com/a.png' };
    const view = cardQuestionViewFromDetail(
      question({
        id: 'q2',
        title: '어느 쪽으로 갈까요',
        kind: 'choice',
        optionDetails: [
          { label: '동쪽', description: '빠름', recommended: true },
          { label: '서쪽' },
        ],
        attachments: [attachment],
      }),
      [],
      '카드 제목',
    );
    expect(view.title).toBe('어느 쪽으로 갈까요');
    expect(view.kind).toBe('choice');
    expect(view.options).toEqual([
      { label: '동쪽', description: '빠름', recommended: true },
      { label: '서쪽', description: null, recommended: false },
    ]);
    expect(view.attachments).toEqual([attachment]);
    expect(view.open).toBe(true);
    expect(view.selectedOption).toBeNull();
    expect(view.answer).toBeNull();
  });

  it('부탁 질문은 kind를 request로 읽는다', () => {
    const view = cardQuestionViewFromDetail(question({ kind: 'request', title: '배포해 주세요' }), [], '카드 제목');
    expect(view.kind).toBe('request');
    expect(view.title).toBe('배포해 주세요');
  });

  it('글타래는 questionId가 같은 커멘트만 createdAt, id 순으로 모은다', () => {
    const view = cardQuestionViewFromDetail(question(), [
      comment({ id: 'c3', createdAt: '2026-11-12T10:03:00Z', authorKind: 'agent', body: '담당 답' }),
      comment({ id: 'c2', createdAt: '2026-11-12T10:02:00Z', authorKind: 'user', body: '되묻기' }),
      comment({ id: 'b', createdAt: '2026-11-12T10:02:00Z', authorKind: 'user', body: '같은 시각' }),
      comment({ id: 'c9', questionId: 'other', createdAt: '2026-11-12T10:04:00Z', body: '다른 질문' }),
      comment({ id: 'c8', questionId: null, createdAt: '2026-11-12T10:05:00Z', body: '일반 커멘트' }),
    ], '카드 제목');
    expect(view.thread).toEqual([
      { id: 'b', author: 'user', body: '같은 시각', at: '2026-11-12T10:02:00Z' },
      { id: 'c2', author: 'user', body: '되묻기', at: '2026-11-12T10:02:00Z' },
      { id: 'c3', author: 'agent', body: '담당 답', at: '2026-11-12T10:03:00Z' },
    ]);
  });

  it('열린 질문의 글타래 마지막이 사용자 글이면 담당을 기다린다', () => {
    const waiting = cardQuestionViewFromDetail(question(), [comment({ authorKind: 'user' })], '카드 제목');
    expect(waiting.open).toBe(true);
    expect(waiting.awaitingAgent).toBe(true);

    const answeredByAgent = cardQuestionViewFromDetail(question(), [
      comment({ id: 'c1', authorKind: 'user' }),
      comment({ id: 'c2', authorKind: 'agent', createdAt: '2026-11-12T10:02:00Z' }),
    ], '카드 제목');
    expect(answeredByAgent.awaitingAgent).toBe(false);

    const closed = cardQuestionViewFromDetail(
      question({ answer: '네' }),
      [comment({ authorKind: 'user' })],
      '카드 제목',
    );
    expect(closed.open).toBe(false);
    expect(closed.awaitingAgent).toBe(false);
  });

  it('고침 시각은 revision이 2 이상일 때만 싣는다', () => {
    const revised = cardQuestionViewFromDetail(
      question({ revision: 2, revisedAt: '2026-11-12T14:18:00Z' }),
      [],
      '카드 제목',
    );
    expect(revised.revisedAt).toBe('2026-11-12T14:18:00Z');

    const first = cardQuestionViewFromDetail(
      question({ revision: 1, revisedAt: '2026-11-12T14:18:00Z' }),
      [],
      '카드 제목',
    );
    expect(first.revisedAt).toBeNull();

    const revisionWithoutTime = cardQuestionViewFromDetail(question({ revision: 3 }), [], '카드 제목');
    expect(revisionWithoutTime.revisedAt).toBeNull();
  });

  it('글 답은 selectedOption이 null이면 선택지 이름과 겹쳐도 고른 것으로 보지 않는다', () => {
    const view = cardQuestionViewFromDetail(
      question({ options: ['파랑'], answer: '파랑', selectedOption: null, answeredAt: '2026-11-12T10:05:00Z' }),
      [],
      '카드 제목',
    );
    expect(view.selectedOption).toBeNull();
    expect(view.answer).toBe('파랑');
  });

  it('철회한 질문은 닫힌 것으로 읽는다', () => {
    const view = cardQuestionViewFromDetail(question({ withdrawnAt: '2026-11-12T10:06:00Z' }), [], '카드 제목');
    expect(view.open).toBe(false);
  });
});

describe('cardQuestionViewFromEntry', () => {
  it('PAS 장의 질문 칸을 그대로 보기로 옮긴다', () => {
    const view = cardQuestionViewFromEntry(entry({
      question_id: 'q1',
      question_title: '어느 쪽으로 갈까요',
      question_text: '배경 전문',
      question_kind: 'choice',
      question_option_details: [{ label: '동쪽', description: '빠름', recommended: true }, { label: '서쪽' }],
      question_attachments: [{ type: 'link', label: '문서', url: 'https://example.com/doc' }],
      question_thread: [
        { id: 't1', question_id: 'q1', author_kind: 'user', body: '되묻기', created_at: '2026-11-12T10:01:00Z', session_id: null },
        { id: 't2', question_id: 'q1', author_kind: 'agent', body: '담당 답', created_at: '2026-11-12T10:02:00Z', session_id: 'sess-1' },
      ],
      question_revision: 2,
      question_revised_at: '2026-11-12T14:18:00Z',
    }));
    expect(view).toEqual({
      id: 'q1',
      title: '어느 쪽으로 갈까요',
      background: '배경 전문',
      kind: 'choice',
      options: [
        { label: '동쪽', description: '빠름', recommended: true },
        { label: '서쪽', description: null, recommended: false },
      ],
      attachments: [{ type: 'link', label: '문서', url: 'https://example.com/doc' }],
      thread: [
        { id: 't1', author: 'user', body: '되묻기', at: '2026-11-12T10:01:00Z' },
        { id: 't2', author: 'agent', body: '담당 답', at: '2026-11-12T10:02:00Z' },
      ],
      open: true,
      selectedOption: null,
      answer: null,
      revisedAt: '2026-11-12T14:18:00Z',
      awaitingAgent: false,
    });
  });

  it('질문 칸이 없는 옛 장은 장 제목과 배경, 이름표 선택지로 대신한다', () => {
    const view = cardQuestionViewFromEntry(entry({
      title: '카드 제목 24자',
      context: '옛 장 배경',
      options: ['파랑', '빨강'],
      question_id: undefined,
      state: 'answered',
      answer: '파랑',
    }));
    expect(view.id).toBe('cq_q1');
    expect(view.title).toBe('카드 제목 24자');
    expect(view.background).toBe('옛 장 배경');
    expect(view.kind).toBe('choice');
    expect(view.options).toEqual([
      { label: '파랑', description: null, recommended: false },
      { label: '빨강', description: null, recommended: false },
    ]);
    expect(view.open).toBe(false);
    expect(view.selectedOption).toBe('파랑');
    expect(view.answer).toBe('파랑');
    expect(view.thread).toEqual([]);
    expect(view.revisedAt).toBeNull();
  });

  it('열린 장에서 사용자 글이 마지막이면 담당을 기다린다', () => {
    const view = cardQuestionViewFromEntry(entry({
      question_thread: [
        { id: 't1', question_id: 'q1', author_kind: 'user', body: '되묻기', created_at: '2026-11-12T10:01:00Z', session_id: null },
      ],
    }));
    expect(view.open).toBe(true);
    expect(view.awaitingAgent).toBe(true);
  });

  it('글 답 장은 선택지 이름과 겹쳐도 고른 것으로 보지 않는다', () => {
    const view = cardQuestionViewFromEntry(entry({
      state: 'answered',
      answer: '파랑',
      options: ['파랑'],
    }));
    expect(view.selectedOption).toBe('파랑');

    const text = cardQuestionViewFromEntry(entry({
      state: 'answered',
      answer: '파랑이 좋겠어요',
      options: ['파랑'],
    }));
    expect(text.selectedOption).toBeNull();
    expect(text.answer).toBe('파랑이 좋겠어요');
  });

  it('고친 장은 revision이 2 이상일 때만 고침 시각을 싣는다', () => {
    expect(cardQuestionViewFromEntry(entry({ question_revision: 2, question_revised_at: '2026-11-12T14:18:00Z' })).revisedAt)
      .toBe('2026-11-12T14:18:00Z');
    expect(cardQuestionViewFromEntry(entry({ question_revision: 1, question_revised_at: '2026-11-12T14:18:00Z' })).revisedAt)
      .toBeNull();
  });
});
