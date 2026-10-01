import {
  groupChatEvents,
  placePendingOptimistic,
} from '../groupChatEvents';
import type { SessionEvent } from '../../../api/types';
import { createOptimisticUserEvent } from '../../../store/chatStore';

const ev = (
  id: string,
  type: SessionEvent['type'],
  data: Record<string, unknown> = {},
): SessionEvent => ({ id, type, data });

const keys = (events: SessionEvent[]) =>
  groupChatEvents(events).map((item) => item.key);

const rowSignatures = (events: SessionEvent[]) =>
  groupChatEvents(events).map((item) => {
    const summaries =
      item.kind === 'event' || item.kind === 'tool'
        ? item.summaries?.map((summary) => summary.key) ?? []
        : [];
    return summaries.length > 0
      ? `${item.key}[${summaries.join(',')}]`
      : item.key;
  });

describe('groupChatEvents turn summary direct anchor projection', () => {
  it('사례 세션의 세 요약을 각각 final response 바로 뒤에 둔다', () => {
    const events = [
      ev('12371', 'user_message', { text: '질문 11' }),
      ev('12484', 'assistant_message', { text: '응답 11' }),
      ev('12485', 'complete'),
      ev('12492', 'session_notification', { text: '질문 12' }),
      ev('12547', 'assistant_message', { text: '응답 12' }),
      ev('12548', 'complete'),
      ev('12555', 'session_notification', { text: '질문 13' }),
      ev('12586', 'assistant_message', { text: '응답 13' }),
      ev('12587', 'complete'),
      ev('12490', 'turn_summary', {
        content: '요약 11',
        final_response_event_id: 12484,
        parent_event_id: 12484,
      }),
      ev('12553', 'turn_summary', {
        content: '요약 12',
        final_response_event_id: 12547,
        parent_event_id: 12547,
      }),
      ev('12592', 'turn_summary', {
        content: '요약 13',
        final_response_event_id: 12586,
        parent_event_id: 12586,
      }),
    ];

    expect(rowSignatures(events)).toEqual([
      'evt-12371',
      'evt-12484[turn-summary-12490]',
      'evt-12485',
      'evt-12492',
      'evt-12547[turn-summary-12553]',
      'evt-12548',
      'evt-12555',
      'evt-12586[turn-summary-12592]',
      'evt-12587',
    ]);
  });

  it('final을 우선하고 final 미로딩이면 로드된 parent로 fallback한다', () => {
    const finalLoaded = ev('20', 'assistant_message', { text: 'final' });
    const parentLoaded = ev('21', 'assistant_message', { text: 'parent' });
    const summary = ev('40', 'turn_summary', {
      content: '요약',
      final_response_event_id: 20,
      parent_event_id: 21,
    });

    expect(rowSignatures([finalLoaded, parentLoaded, summary])).toEqual([
      'evt-20[turn-summary-40]',
      'evt-21',
    ]);
    expect(rowSignatures([parentLoaded, summary])).toEqual([
      'evt-21[turn-summary-40]',
    ]);
  });

  it('유효 anchor가 미로딩이면 숨고 prepend 뒤 같은 key로 결합한다', () => {
    const summary = ev('40', 'turn_summary', {
      content: '페이지 경계 요약',
      final_response_event_id: 2,
      parent_event_id: 2,
    });
    const latest = ev('10', 'user_message', { text: '최신 질문' });

    expect(keys([latest, summary])).toEqual(['evt-10']);
    expect(
      rowSignatures([
        ev('1', 'user_message', { text: '과거 질문' }),
        ev('2', 'assistant_message', { text: '과거 응답' }),
        ev('3', 'complete'),
        latest,
        summary,
      ]),
    ).toEqual([
      'evt-1',
      'evt-2[turn-summary-40]',
      'evt-3',
      'evt-10',
    ]);
  });

  it('유효 anchor 후보가 전혀 없는 legacy만 자기 event ID 위치로 fail-open한다', () => {
    expect(
      keys([
        ev('1', 'user_message'),
        ev('3', 'assistant_message'),
        ev('2', 'turn_summary', { content: 'legacy 요약' }),
        ev('4', 'complete'),
      ]),
    ).toEqual(['evt-1', 'turn-summary-2', 'evt-3', 'evt-4']);
  });

  it('같은 anchor의 복수 요약은 event ID 순서이며 duplicate ID는 한 번만 표시한다', () => {
    const anchor = ev('2', 'assistant_message');
    const first = ev('40', 'turn_summary', {
      content: '첫 요약',
      final_response_event_id: 2,
    });
    const second = ev('41', 'turn_summary', {
      content: '둘째 요약',
      final_response_event_id: 2,
    });

    expect(rowSignatures([anchor, second, first, second])).toEqual([
      'evt-2[turn-summary-40,turn-summary-41]',
    ]);
  });

  it('malformed summary가 유효 summary 사이에 있어도 deterministic total order를 유지한다', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const anchor = ev('2', 'assistant_message');
    const later = ev('100', 'turn_summary', {
      content: '나중 요약',
      final_response_event_id: 2,
    });
    const malformed = ev('invalid-id', 'turn_summary', {
      content: '잘못된 ID',
      final_response_event_id: 2,
    });
    const earlier = ev('10', 'turn_summary', {
      content: '먼저 요약',
      final_response_event_id: 2,
    });

    const permutations = [
      [later, malformed, earlier],
      [later, earlier, malformed],
      [malformed, later, earlier],
      [malformed, earlier, later],
      [earlier, later, malformed],
      [earlier, malformed, later],
    ];
    for (const summaries of permutations) {
      expect(rowSignatures([anchor, ...summaries])).toEqual([
        'evt-2[turn-summary-10,turn-summary-100]',
      ]);
    }
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('event id is invalid'),
    );
    warn.mockRestore();
  });

  it('positive safe integer가 아닌 후보는 legacy로 취급하고 빈 content만 숨긴다', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = groupChatEvents([
      ev('2', 'assistant_message'),
      ev('3', 'turn_summary', {
        content: 'legacy',
        final_response_event_id: Number.MAX_SAFE_INTEGER + 1,
      }),
      ev('4', 'turn_summary', { final_response_event_id: 2 }),
    ]);

    expect(result.map((item) => item.key)).toEqual([
      'evt-2',
      'turn-summary-3',
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('content is missing'),
    );
    warn.mockRestore();
  });

  it('payload의 숫자 문자열은 anchor가 아니라 legacy event 위치로 fail-open한다', () => {
    expect(
      rowSignatures([
        ev('10', 'assistant_message'),
        ev('15', 'turn_summary', {
          content: '문자열 anchor 요약',
          final_response_event_id: '20',
          parent_event_id: '20',
        }),
        ev('20', 'assistant_message'),
        ev('30', 'complete'),
      ]),
    ).toEqual([
      'evt-10',
      'turn-summary-15',
      'evt-20',
      'evt-30',
    ]);
  });

  it('과거 요약의 event ID가 커도 pending optimistic보다 앞의 anchor 뒤에 남는다', () => {
    const pending = {
      ...createOptimisticUserEvent('다음 질문', 'user_message'),
      data: {
        text: '다음 질문',
        user: 'soul-app',
        __optimisticAfterEventId: '3',
      },
    };
    const out = placePendingOptimistic(
      groupChatEvents([
        ev('2', 'assistant_message', { text: '답변' }),
        ev('3', 'complete'),
        ev('40', 'turn_summary', {
          content: '완료된 턴 요약',
          final_response_event_id: 2,
        }),
      ]),
      pending,
    );

    expect(out.map((item) => item.key)).toEqual([
      'evt-2',
      'evt-3',
      `evt-${pending.id}`,
    ]);
    expect(out[0]).toMatchObject({
      key: 'evt-2',
      summaries: [{ key: 'turn-summary-40' }],
    });
  });
});
