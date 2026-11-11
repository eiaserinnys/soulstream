import { renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { useChatRenderItems } from '../useChatRenderItems';

const ev = (id: string, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent => ({ id, type, data });
const line = (id: string, lineKey: string, title: string, status = 'review') => ev(id, 'report_timeline', {
  line_key: lineKey, status, title, detail: '', card_id: `card-${lineKey}`, card_number: 1,
});

function renderTimeline(events: SessionEvent[], presentation: 'default' | 'manuscript' = 'manuscript') {
  const { result } = renderHook(() => useChatRenderItems({
    events, pendingOptimistic: undefined, streamingSlots: undefined,
    sessionStatus: 'completed', presentation,
  }));
  return [...result.current.reversedItems].reverse();
}

describe('useChatRenderItems report timeline', () => {
  it('같은 line_key는 대화 없이 갱신되고 도구 항목은 갱신 경계를 만들지 않는다', () => {
    const rows = renderTimeline([
      line('first', 'card-1', '이전 상태'),
      ev('tool', 'tool_start', { tool_use_id: 'tool-1', tool_name: 'Read' }),
      ev('tool-result', 'tool_result', { tool_use_id: 'tool-1' }),
      line('latest', 'card-1', '최신 상태'),
    ]);

    expect(rows.filter((item) => item.kind === 'event' && item.event.type === 'report_timeline'))
      .toHaveLength(1);
    expect(rows.find((item) => item.kind === 'event' && item.event.type === 'report_timeline'))
      .toMatchObject({ event: { id: 'latest', data: { title: '최신 상태' } } });
  });

  it('사용자 또는 에이전트 대화가 끼면 이전 줄을 남기고 다음 갱신을 별도 줄로 둔다', () => {
    const rows = renderTimeline([
      line('first', 'card-1', '이전 상태'),
      ev('user', 'user_message', { text: '확인할게요' }),
      line('latest', 'card-1', '최신 상태'),
    ]);

    expect(rows.filter((item) => item.kind === 'event' && item.event.type === 'report_timeline'))
      .toHaveLength(2);
  });

  it('보이지 않는 턴 사이 보고 줄과 대화 문단만 일정하게 남긴다', () => {
    const rows = renderTimeline([
      ev('paragraph', 'assistant_message', { text: '앞 문단' }),
      line('930-review', '930', '930 검수'),
      ev('agent-input', 'user_message', {
        text: '위임 보고',
        caller_info: { source: 'agent', agent_node: 'eiaserinnys', agent_id: 'agent-1' },
      }),
      line('926-done', '926', '926 완료', 'done'),
      ev('notification', 'session_notification', {
        delivery_intent: 'completion_notification', disposition: 'queued', text: '완료 알림',
      }),
      line('932-review', '932', '932 검수'),
      line('930-done', '930', '930 완료', 'done'),
      ev('8', 'assistant_message', { text: '[SILENT]' }),
      line('932-done', '932', '932 완료', 'done'),
      line('918-review', '918', '918 검수'),
      ev('10', 'complete', { result: '완료' }),
      ev('11', 'session_ended', { status: 'completed' }),
      line('932-review-latest', '932', '932 최신 검수'),
      line('932-done-latest', '932', '932 최신 완료', 'done'),
      ev('12', 'turn_summary', {
        content: '완료한 작업 요약', final_response_event_id: 8, parent_event_id: 8,
      }),
    ]);

    expect(rows.map((item) => item.kind === 'event' ? item.event.type : item.kind)).toEqual([
      'assistant_message', 'report_timeline', 'report_timeline', 'report_timeline', 'report_timeline',
    ]);
    expect(rows
      .filter((item) => item.kind === 'event' && item.event.type === 'report_timeline')
      .map((item) => item.kind === 'event' ? item.event.data : null))
      .toEqual([
        expect.objectContaining({ line_key: '930', status: 'done', title: '930 완료' }),
        expect.objectContaining({ line_key: '926', status: 'done', title: '926 완료' }),
        expect.objectContaining({ line_key: '932', status: 'done', title: '932 최신 완료' }),
        expect.objectContaining({ line_key: '918', status: 'review', title: '918 검수' }),
      ]);
  });

  it('질문 줄은 답함과 철회로 닫히고 닫힘 사건은 행으로 남지 않는다', () => {
    const question = (id: string, questionId: string, title: string) => ev(id, 'report_timeline', {
      line_key: `card:${questionId}`, status: 'question', question_id: questionId, title,
      detail: `${title} 상세`, card_id: `card-${questionId}`, card_number: 1,
    });
    const closing = (id: string, questionId: string, status: 'answered' | 'withdrawn') =>
      ev(id, 'report_timeline_question_closed', {
        closures: [{ question_id: questionId, line_key: `card:${questionId}`,
          detail: `${questionId} 상세`, status }],
      });
    const rows = renderTimeline([
      question('q1', 'question-1', '첫 질문'),
      closing('c1', 'question-1', 'answered'),
      ev('user', 'user_message', { text: '답을 확인했습니다' }),
      question('q2', 'question-2', '둘째 질문'),
      ev('answer', 'assistant_message', { text: '확인했습니다' }),
      closing('c2', 'question-2', 'answered'),
      question('q3', 'question-3', '셋째 질문'),
      question('q4', 'question-4', '넷째 질문'),
      closing('c4', 'question-4', 'withdrawn'),
    ]);

    const rowsOfQuestion = (questionId: string) => rows.find((item) =>
      item.kind === 'event' && item.event.type === 'report_timeline'
      && item.event.data.question_id === questionId);
    expect(rows.filter((item) => item.kind === 'event' && item.event.type === 'report_timeline_question_closed'))
      .toHaveLength(0);
    expect(rowsOfQuestion('question-1')).toMatchObject({ event: { data: { status: 'answered' } } });
    expect(rowsOfQuestion('question-2')).toMatchObject({ event: { data: { status: 'answered' } } });
    expect(rowsOfQuestion('question-3')).toMatchObject({ event: { data: { status: 'question' } } });
    expect(rowsOfQuestion('question-4')).toMatchObject({ event: { data: { status: 'withdrawn' } } });
  });

  it('기본 채팅에서는 session_ended 행만 빼고 complete 표시는 유지한다', () => {
    const rows = renderTimeline([
      ev('ended', 'session_ended', { status: 'completed' }),
      ev('complete', 'complete', { result: '완료' }),
    ], 'default');

    expect(rows.map((item) => item.kind === 'event' ? item.event.type : item.kind))
      .toEqual(['complete']);
  });
});
