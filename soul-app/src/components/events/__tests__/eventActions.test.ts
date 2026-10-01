import type { SessionEvent } from '../../../api/types';
import {
  buildEventAddress,
  buildSystemEventText,
  extractEventCopyText,
  formatTokenUsage,
} from '../eventActions';

function ev(type: SessionEvent['type'], data: Record<string, unknown>): SessionEvent {
  return { id: '42', type, data };
}

describe('eventActions', () => {
  test.each([
    ['complete', '턴 완료'],
    ['result', '세션 완료'],
  ] as const)('%s는 수치가 없으면 답변 본문 대신 고정 라벨을 표시한다', (type, label) => {
    expect(buildSystemEventText(ev(type, {
      success: true,
      message: '이미 표시된 안내',
      content: '이미 표시된 본문',
      result: '이미 표시된 최종 답변',
      output: '이미 표시된 출력',
    }))).toBe(label);
  });

  test.each([undefined, { input_tokens: 10, output_tokens: 5 }])(
    '실패 result는 수치 요약보다 오류 본문을 우선한다 (usage: %j)',
    (usage) => {
      expect(buildSystemEventText(ev('result', {
        success: false,
        error: '응답 생성에 실패했습니다.',
        output: '다른 출력',
        usage,
        total_cost_usd: 0.01,
      }))).toBe('오류: 응답 생성에 실패했습니다.');
    },
  );

  test('실패 result는 실제 output을 보존하고 빈 본문이면 오류 라벨을 표시한다', () => {
    expect(buildSystemEventText(ev('result', {
      success: false, output: '사용량 한도에 도달했습니다.',
    }))).toBe('오류: 사용량 한도에 도달했습니다.');
    expect(buildSystemEventText(ev('result', { success: false }))).toBe('오류');
  });

  test('토큰 사용량을 dashboard와 같은 형식으로 요약한다', () => {
    expect(
      formatTokenUsage({
        input_tokens: 1000,
        output_tokens: 2000,
        cached_input_tokens: 300,
        reasoning_output_tokens: 400,
      }),
    ).toBe('3,000 tokens (1,000 in / 2,000 out / 300 cached / 400 reasoning)');
  });

  test('complete 이벤트의 비용과 토큰 사용량을 표시한다', () => {
    expect(
      buildSystemEventText(
        ev('complete', {
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0.012345,
        }),
      ),
    ).toBe('Turn Complete  $0.0123  15 tokens (10 in / 5 out)');
  });

  test('assistant content blocks를 복사 텍스트로 합친다', () => {
    expect(
      extractEventCopyText(
        ev('assistant_message', {
          content: [
            { type: 'text', text: '안녕' },
            { type: 'image', source: 'skip' },
            { type: 'text', text: '하세요' },
          ],
        }),
      ),
    ).toBe('안녕하세요');
  });

  test('구조화 도구 배열은 annotations와 비text 블록까지 복사한다', () => {
    const result = [
      { type: 'text', text: '본문', annotations: { source: 'fixture' }, extra: 7 },
      { type: 'image', source: { media_type: 'image/png', data: 'abc' } },
    ];

    expect(extractEventCopyText(ev('tool_result', { result })))
      .toBe(JSON.stringify(result, null, 2));
  });

  test('이벤트 주소는 세션과 이벤트 ID를 포함한다', () => {
    expect(buildEventAddress('sess 1', 'event/2')).toBe(
      'soulstream://sessions/sess%201/events/event%2F2',
    );
  });

  test('session_notification은 사용자 발화가 아닌 완료 알림으로 표시한다', () => {
    const event = ev('session_notification', {
      delivery_id: '66666666-6666-4666-8666-666666666666',
      delivery_intent: 'completion_notification',
      source: 'completion_notifier',
      text: '피위임 세션이 완료되었습니다.',
      disposition: 'queued',
    });

    expect(buildSystemEventText(event)).toBe(
      '완료 알림: 피위임 세션이 완료되었습니다.',
    );
    expect(extractEventCopyText(event)).toBe(
      '완료 알림: 피위임 세션이 완료되었습니다.',
    );
  });

  test('session_notification에 리밋 종류와 해제 countdown을 표시하고 복사한다', () => {
    const event = ev('session_notification', {
      delivery_id: '77777777-7777-4777-8777-777777777777',
      delivery_intent: 'completion_notification',
      source: 'completion_notifier',
      text: '피위임 세션이 중단되었습니다.',
      disposition: 'queued',
      rate_limit_type: 'five_hour',
      resets_at: '2999-09-26T03:12:00.000Z',
    });

    const text = buildSystemEventText(event);
    expect(text).toContain('5시간 한도');
    expect(text).toContain('해제 시각');
    expect(text).toContain('KST');
    expect(text).toContain('남음');
    expect(extractEventCopyText(event)).toBe(text);
  });

  test('reset이 없으면 현재 오류 문구에 알려진 리밋 종류만 덧붙인다', () => {
    const event = ev('error', {
      message: '요청이 사용량 제한으로 중단되었습니다.',
      error_code: 'claude_rate_limit_stop_failure',
      rate_limit_type: 'seven_day',
    });

    expect(buildSystemEventText(event))
      .toBe('오류: 요청이 사용량 제한으로 중단되었습니다.\n\n주간 한도');
  });

  test('retryable error는 현재 상태가 아닌 자동 재연결 발생 이력으로 표시·복사한다', () => {
    const event = ev('error', {
      message: 'Reconnecting... 2/2',
      fatal: false,
      will_retry: true,
    });
    const expected =
      '응답 연결이 끊겨 같은 작업에 자동 재연결이 발생했습니다. Reconnecting... 2/2';

    expect(buildSystemEventText(event)).toBe(expected);
    expect(extractEventCopyText(event)).toBe(expected);
  });

  test.each([
    ['false', false],
    ['누락', undefined],
  ])('will_retry %s error는 기존 오류 표현을 유지한다', (_label, willRetry) => {
    const event = ev('error', {
      message: 'Something went wrong',
      ...(willRetry === undefined ? {} : { will_retry: willRetry }),
    });

    expect(buildSystemEventText(event)).toBe('오류: Something went wrong');
    expect(extractEventCopyText(event)).toBe('오류: Something went wrong');
  });
});
