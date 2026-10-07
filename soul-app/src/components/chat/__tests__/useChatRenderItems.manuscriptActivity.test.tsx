import { renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { useChatRenderItems } from '../useChatRenderItems';

const ev = (id: string, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent => ({
  id,
  type,
  data,
});

describe('useChatRenderItems manuscript activity', () => {
  it('원고형에서 저장 도구 호출과 스트리밍 생각 행을 함께 접고 바닥 추적 키도 접힌 행을 가리킨다', () => {
    const toolStart = ev('1', 'tool_start', { tool_use_id: 'tool-1', tool_name: 'Read' });
    const toolResult = ev('2', 'tool_result', { tool_use_id: 'tool-1', result: 'done' });
    const thinking = ev('stream-thinking', 'thinking_delta', { thinking: '검토 중' });
    const { result } = renderHook(() => useChatRenderItems({
      events: [toolStart, toolResult],
      pendingOptimistic: undefined,
      streamingSlots: { thinking },
      sessionStatus: 'running',
      presentation: 'manuscript',
    }));

    const activity = result.current.reversedItems.find((item) => item.kind === 'activity');
    expect(activity).toMatchObject({
      kind: 'activity',
      key: 'activity-tool-1',
      items: [
        { kind: 'tool', start: toolStart, result: toolResult },
        { kind: 'event', event: thinking },
      ],
    });
    expect(result.current.bottomFollowItemKey).toBe('activity-tool-1');
  });

  it('일반 채팅에서는 이벤트와 도구 행을 따로 유지한다', () => {
    const toolStart = ev('1', 'tool_start', { tool_use_id: 'tool-1' });
    const toolResult = ev('2', 'tool_result', { tool_use_id: 'tool-1' });
    const thinking = ev('stream-thinking', 'thinking_delta', { thinking: '검토 중' });
    const { result } = renderHook(() => useChatRenderItems({
      events: [toolStart, toolResult],
      pendingOptimistic: undefined,
      streamingSlots: { thinking },
      sessionStatus: 'running',
      presentation: 'default',
    }));

    expect(result.current.reversedItems.map((item) => item.kind)).toEqual(['typing', 'event', 'tool']);
    expect(result.current.bottomFollowItemKey).toBe('stream-thinking');
  });
});
