import { renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { useChatRenderItems } from '../useChatRenderItems';

const ev = (id: string, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent => ({ id, type, data });
const line = (id: string, lineKey: string, title: string) => ev(id, 'report_timeline', {
  line_key: lineKey, status: 'review', title, detail: '', card_id: 'card-1', card_number: 1,
});

function renderTimeline(events: SessionEvent[]) {
  const { result } = renderHook(() => useChatRenderItems({
    events, pendingOptimistic: undefined, streamingSlots: undefined,
    sessionStatus: 'completed', presentation: 'manuscript',
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
});
