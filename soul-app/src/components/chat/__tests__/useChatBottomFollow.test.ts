import { act, renderHook } from '@testing-library/react-native';
import type { FlatList } from 'react-native';
import type { SessionEvent } from '../../../api/types';
import type { ChatRenderItem } from '../groupChatEvents';
import { useChatBottomFollow } from '../useChatBottomFollow';
import { useChatRenderItems } from '../useChatRenderItems';

function createListRef() {
  return {
    current: {
      recordInteraction: jest.fn(),
      scrollToOffset: jest.fn(),
    },
  } as unknown as React.RefObject<FlatList<ChatRenderItem> | null>;
}

function tool(id: string): SessionEvent {
  return { id, type: 'tool_start', data: { tool_use_id: `tool-${id}`, tool_name: 'Read' } };
}

describe('useChatBottomFollow', () => {
  let animationFrames: FrameRequestCallback[];

  beforeEach(() => {
    animationFrames = [];
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    jest.spyOn(global, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function flushAnimationFrame() {
    const callback = animationFrames.shift();
    if (!callback) throw new Error('예약된 animation frame이 없습니다.');
    act(() => callback(0));
  }

  it('첫 optimistic instruction도 하단 이동 대상으로 삼는다', () => {
    const flatListRef = createListRef();

    renderHook(() =>
      useChatBottomFollow({
        flatListRef,
        sessionId: 'sess-new',
        bottomItemKey: 'evt-optimistic-first-message',
      }),
    );

    expect(animationFrames).toHaveLength(1);
    flushAnimationFrame();
    expect(flatListRef.current?.scrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
  });

  it('세션이 바뀌면 bottom key가 같아도 새 viewport를 다시 하단에 맞춘다', () => {
    const flatListRef = createListRef();
    const { rerender } = renderHook<
      ReturnType<typeof useChatBottomFollow>,
      { sessionId: string }
    >(
      ({ sessionId }) =>
        useChatBottomFollow({
          flatListRef,
          sessionId,
          bottomItemKey: 'typing-indicator',
        }),
      { initialProps: { sessionId: 'sess-a' } },
    );
    flushAnimationFrame();
    (flatListRef.current?.scrollToOffset as jest.Mock).mockClear();

    rerender({ sessionId: 'sess-b' });

    expect(animationFrames).toHaveLength(1);
    flushAnimationFrame();
    expect(flatListRef.current?.scrollToOffset).toHaveBeenCalledTimes(1);
  });

  it('같은 streaming slot의 높이만 커져도 하단을 다시 맞춘다', () => {
    const flatListRef = createListRef();
    const { result } = renderHook(() =>
      useChatBottomFollow({
        flatListRef,
        sessionId: 'sess-stream',
        bottomItemKey: 'stream-assistant-item-1',
      }),
    );
    flushAnimationFrame();
    (flatListRef.current?.scrollToOffset as jest.Mock).mockClear();

    act(() => result.current.onScrollOffsetChange(0));
    act(() => result.current.onContentSizeChange(120));
    flushAnimationFrame();
    (flatListRef.current?.scrollToOffset as jest.Mock).mockClear();

    act(() => result.current.onScrollOffsetChange(0));
    act(() => result.current.onContentSizeChange(420));
    flushAnimationFrame();

    expect(flatListRef.current?.scrollToOffset).toHaveBeenCalledTimes(1);
    expect(flatListRef.current?.scrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
  });

  it('하단 도착 전 콘텐츠가 다시 커지면 시간 cooldown 없이 다음 frame을 예약한다', () => {
    const flatListRef = createListRef();
    const { result } = renderHook(() =>
      useChatBottomFollow({
        flatListRef,
        sessionId: 'sess-pending',
        bottomItemKey: 'stream-assistant-item-1',
      }),
    );
    flushAnimationFrame();

    act(() => result.current.onScrollOffsetChange(48));
    act(() => result.current.onContentSizeChange(180));

    expect(animationFrames).toHaveLength(1);
    flushAnimationFrame();
    expect(flatListRef.current?.scrollToOffset).toHaveBeenCalledTimes(2);
  });

  it('사용자가 과거 메시지로 드래그하면 콘텐츠 증가가 viewport를 되돌리지 않는다', () => {
    const flatListRef = createListRef();
    const { result } = renderHook(() =>
      useChatBottomFollow({
        flatListRef,
        sessionId: 'sess-reader',
        bottomItemKey: 'stream-assistant-item-1',
      }),
    );
    flushAnimationFrame();
    (flatListRef.current?.scrollToOffset as jest.Mock).mockClear();

    act(() => result.current.onScrollBeginDrag());
    act(() => result.current.onScrollOffsetChange(100));
    act(() => result.current.onContentSizeChange(520));

    expect(animationFrames).toHaveLength(0);
    expect(flatListRef.current?.scrollToOffset).not.toHaveBeenCalled();

    act(() => result.current.onScrollOffsetChange(0));
    act(() => result.current.onContentSizeChange(620));
    flushAnimationFrame();
    expect(flatListRef.current?.scrollToOffset).toHaveBeenCalledTimes(1);
  });

  it('따라가기가 꺼진 뒤 새 하단 항목이 오면 표시하고, 하단 이동 요청에서 숨긴다', () => {
    const flatListRef = createListRef();
    const { result, rerender } = renderHook<
      ReturnType<typeof useChatBottomFollow>,
      { bottomItemKey: string }
    >(
      ({ bottomItemKey }) => useChatBottomFollow({
        flatListRef,
        sessionId: 'sess-new-message',
        bottomItemKey,
        presentation: 'manuscript',
      }),
      { initialProps: { bottomItemKey: 'event-1' } },
    );
    flushAnimationFrame();
    act(() => {
      result.current.onScrollBeginDrag();
      result.current.onScrollOffsetChange(80);
    });

    rerender({ bottomItemKey: 'event-2' });
    expect(result.current.showNewMessage).toBe(true);

    act(() => result.current.requestBottomFollow());
    expect(result.current.showNewMessage).toBe(false);
    flushAnimationFrame();
    expect(flatListRef.current?.scrollToOffset).toHaveBeenLastCalledWith({
      offset: 0,
      animated: false,
    });

    act(() => result.current.onScrollOffsetChange(0));
    expect(result.current.showNewMessage).toBe(false);
  });

  function renderManuscriptFollow(initialEvents: SessionEvent[]) {
    const flatListRef = createListRef();
    const hook = renderHook(
      ({ events }: { events: SessionEvent[] }) => {
        const { bottomFollowItemKey, reversedItems } = useChatRenderItems({
          events,
          pendingOptimistic: undefined,
          streamingSlots: undefined,
          sessionStatus: 'completed',
          presentation: 'manuscript',
        });
        const follow = useChatBottomFollow({
          flatListRef,
          sessionId: 'sess-activity',
          bottomItemKey: bottomFollowItemKey,
          presentation: 'manuscript',
        });
        return { ...follow, reversedItems };
      },
      { initialProps: { events: initialEvents } },
    );
    flushAnimationFrame();
    (flatListRef.current?.scrollToOffset as jest.Mock).mockClear();
    return { ...hook, flatListRef };
  }

  it('바닥을 떠나 활동 묶음 앞에 이전 이력이 붙어도 새 메시지 배너를 보이지 않는다', () => {
    const { result, rerender, flatListRef } = renderManuscriptFollow([tool('2'), tool('3')]);
    act(() => {
      result.current.onScrollBeginDrag();
      result.current.onScrollOffsetChange(80);
    });

    rerender({ events: [tool('0'), tool('1'), tool('2'), tool('3')] });

    expect(result.current.reversedItems[0].key).toBe('activity-tool-0');
    expect(result.current.showNewMessage).toBe(false);
    expect(flatListRef.current?.scrollToOffset).not.toHaveBeenCalled();
  });

  it('바닥을 떠나 활동 묶음 뒤에 도구가 붙으면 새 메시지 배너를 보인다', () => {
    const { result, rerender, flatListRef } = renderManuscriptFollow([tool('2'), tool('3')]);
    act(() => {
      result.current.onScrollBeginDrag();
      result.current.onScrollOffsetChange(80);
    });

    rerender({ events: [tool('2'), tool('3'), tool('4')] });

    expect(result.current.reversedItems[0].key).toBe('activity-tool-2');
    expect(result.current.showNewMessage).toBe(true);
    expect(flatListRef.current?.scrollToOffset).not.toHaveBeenCalled();
  });

  it('바닥에서 활동 묶음 뒤에 도구가 붙으면 따라 내려간다', () => {
    const { result, rerender, flatListRef } = renderManuscriptFollow([tool('2'), tool('3')]);
    act(() => result.current.onScrollOffsetChange(0));

    rerender({ events: [tool('2'), tool('3'), tool('4')] });

    expect(result.current.showNewMessage).toBe(false);
    expect(animationFrames).toHaveLength(1);
    flushAnimationFrame();
    expect(flatListRef.current?.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
  });

  it('같은 frame 안의 연속 요청은 한 번으로 합친다', () => {
    const flatListRef = createListRef();
    const { result } = renderHook(() =>
      useChatBottomFollow({
        flatListRef,
        sessionId: 'sess-coalesce',
        bottomItemKey: null,
      }),
    );

    act(() => {
      result.current.requestBottomFollow();
      result.current.onContentSizeChange(100);
      result.current.onContentSizeChange(200);
    });

    expect(animationFrames).toHaveLength(1);
    flushAnimationFrame();
    expect(flatListRef.current?.scrollToOffset).toHaveBeenCalledTimes(1);
  });
});
