import { act, renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import type { StreamingSlots } from '../../../store/chatStore';
import { useChatRenderItems } from '../useChatRenderItems';

function streamingSlots(text: string): StreamingSlots {
  return {
    assistant: {
      id: 'stream-1',
      session_id: 'session-1',
      type: 'assistant_message',
      timestamp: '2026-10-07T00:00:00Z',
      data: { text },
    } as unknown as SessionEvent,
  };
}

test('원고형 응답 streaming 내용 변경은 하단 follow key를 갱신한다', () => {
  const { result, rerender } = renderHook<ReturnType<typeof useChatRenderItems>, { text: string }>(
    ({ text }: { text: string }) => useChatRenderItems({
      events: [],
      pendingOptimistic: undefined,
      streamingSlots: streamingSlots(text),
      sessionStatus: 'running',
      presentation: 'manuscript',
    }),
    { initialProps: { text: '첫 글자' } },
  );
  const initialKey = result.current.bottomFollowItemKey;

  act(() => rerender({ text: '새 응답 내용' }));

  expect(result.current.bottomFollowItemKey).not.toBe(initialKey);
});
