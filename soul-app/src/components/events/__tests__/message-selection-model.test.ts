import type { SessionEvent } from '../../../api/types';
import { createMessageSelectionModel } from '../message-selection-model';

function event(
  type: SessionEvent['type'],
  data: Record<string, unknown>,
): SessionEvent {
  return { id: 'event-1', type, data };
}

describe('createMessageSelectionModel', () => {
  test('finalized assistant message는 markdown 선택 모델을 만든다', () => {
    expect(
      createMessageSelectionModel(
        event('assistant_message', { content: '**완료**' }),
      ),
    ).toEqual({ kind: 'markdown', text: '**완료**' });
  });

  test.each([
    event('text_delta', { text: '작성 중' }),
    event('assistant_message', { content: '작성 중', _live_only: true }),
  ])('streaming assistant text는 plain 선택 모델을 만든다', (input) => {
    expect(createMessageSelectionModel(input)).toEqual({
      kind: 'plain',
      text: '작성 중',
    });
  });

  test.each([
    event('user_message', { content: '사용자 메시지' }),
    event('intervention_sent', { message: '개입 메시지' }),
    event('realtime_transcript', { role: 'user', text: '음성 메시지' }),
  ])('사용자 계열 메시지는 plain 선택 모델을 만든다', (input) => {
    expect(createMessageSelectionModel(input)?.kind).toBe('plain');
  });

  test('content block 사용자 메시지도 전체 본문을 선택 모델에 보존한다', () => {
    expect(
      createMessageSelectionModel(
        event('user_message', {
          content: [
            { type: 'text', text: '첫 문장' },
            { type: 'image', source: 'skip' },
            { type: 'text', text: '둘째 문장' },
          ],
        }),
      ),
    ).toEqual({ kind: 'plain', text: '첫 문장둘째 문장' });
  });

  test('assistant realtime transcript는 markdown 선택 모델을 만든다', () => {
    expect(
      createMessageSelectionModel(
        event('realtime_transcript', { role: 'assistant', text: '응답' }),
      ),
    ).toEqual({ kind: 'markdown', text: '응답' });
  });

  test.each([
    event('assistant_message', { content: '   ' }),
    event('tool_start', { tool_name: 'Read' }),
    event('system', { message: '공지' }),
  ])('선택할 메시지 본문이 아니면 모델을 만들지 않는다', (input) => {
    expect(createMessageSelectionModel(input)).toBeNull();
  });
});
