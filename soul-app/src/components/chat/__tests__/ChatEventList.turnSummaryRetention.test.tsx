import React, { useRef } from 'react';
import { act, render } from '@testing-library/react-native';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { SessionEvent } from '../../../api/types';
import type { ChatBodyStyles } from '../ChatBody.styles';
import type { ChatRenderItem } from '../groupChatEvents';
import { ChatEventList } from '../ChatEventList';
import { useChatBottomFollow } from '../useChatBottomFollow';
import { useChatRenderItems } from '../useChatRenderItems';

const mockFlatListState = {
  props: null as Record<string, any> | null,
  scrollToOffset: jest.fn(),
  recordInteraction: jest.fn(),
};
const mockRenderOrder: string[] = [];

jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactModule = jest.requireActual('react');
  const MockFlatList = ReactModule.forwardRef((props: any, ref: any) => {
    mockFlatListState.props = props;
    ReactModule.useImperativeHandle(ref, () => ({
      recordInteraction: mockFlatListState.recordInteraction,
      scrollToOffset: (options: { offset: number; animated: boolean }) => {
        mockFlatListState.scrollToOffset(options);
      },
    }));
    return ReactModule.createElement(
      ReactModule.Fragment,
      null,
      props.data.map((item: ChatRenderItem, index: number) =>
        ReactModule.createElement(
          ReactModule.Fragment,
          { key: props.keyExtractor(item, index) },
          props.renderItem({ item, index, separators: {} }),
        ),
      ),
    );
  });
  return { __esModule: true, default: MockFlatList };
});

jest.mock('../../events/EventRenderer', () => ({
  EventRenderer: ({ event }: { event: SessionEvent }) => {
    mockRenderOrder.push(`event:${event.id}`);
    return null;
  },
}));
jest.mock('../../events/EventContextMenu', () => ({
  EventContextMenu: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../events/ToolEvent', () => ({ ToolEvent: () => null }));
jest.mock('../../events/TurnSummaryCaption', () => ({
  TurnSummaryCaption: ({ content }: { content: string }) => {
    mockRenderOrder.push(`summary:${content}`);
    return null;
  },
}));
jest.mock('../TypingIndicator', () => ({ TypingIndicator: () => null }));
jest.mock('../HistoryFetchError', () => ({ HistoryFetchError: () => null }));
jest.mock('../../../theme', () => ({
  useTokens: () => ({ colors: { accentTint: 'transparent', accent: 'blue' } }),
}));

const styles = {
  list: {},
  listContent: {},
} as ChatBodyStyles;

const ev = (
  id: string,
  type: SessionEvent['type'],
  data: Record<string, unknown> = {},
): SessionEvent => ({ id, type, data });

function Harness({
  events,
  sessionId = 'sess-a',
}: {
  events: SessionEvent[];
  sessionId?: string;
}) {
  const flatListRef = useRef<FlatList<ChatRenderItem> | null>(null);
  const { reversedItems, bottomFollowItemKey } = useChatRenderItems({
    events,
    pendingOptimistic: undefined,
    streamingSlots: undefined,
    sessionStatus: undefined,
  });
  const follow = useChatBottomFollow({
    flatListRef,
    sessionId,
    bottomItemKey: bottomFollowItemKey,
  });

  return (
    <ChatEventList
      flatListRef={flatListRef}
      items={reversedItems}
      session={undefined}
      sessionId={sessionId}
      api={null}
      styles={styles}
      accentColor="blue"
      requestOlder={jest.fn()}
      onScroll={(event) =>
        follow.onScrollOffsetChange(event.nativeEvent.contentOffset.y)
      }
      onScrollBeginDrag={follow.onScrollBeginDrag}
      historyLoading={false}
      reachedTop={false}
      hasFetchError={false}
      retryFromError={jest.fn()}
      mvcpEnabled
      onContentSizeChange={follow.onContentSizeChange}
    />
  );
}

describe('turn summary FlatList state transitions', () => {
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    frames = [];
    mockFlatListState.props = null;
    mockFlatListState.scrollToOffset.mockClear();
    mockFlatListState.recordInteraction.mockClear();
    mockRenderOrder.length = 0;
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    jest.spyOn(global, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function flushFrames() {
    while (frames.length > 0) {
      const callback = frames.shift();
      act(() => callback?.(0));
    }
  }

  function enterHistoryReading(stableKey: string, offset: number) {
    const dataKeys = mockFlatListState.props?.data.map(
      (item: ChatRenderItem) => item.key,
    );
    expect(dataKeys).toContain(stableKey);
    act(() => {
      mockFlatListState.props?.onScrollBeginDrag?.();
      mockFlatListState.props?.onScroll?.({
        nativeEvent: { contentOffset: { y: offset } },
      } as NativeSyntheticEvent<NativeScrollEvent>);
    });
    mockFlatListState.scrollToOffset.mockClear();
  }

  function expectHistoryProductContract(stableKey: string) {
    const data = mockFlatListState.props?.data as ChatRenderItem[];
    const keyExtractor = mockFlatListState.props?.keyExtractor as (
      item: ChatRenderItem,
    ) => string;
    expect(data.map(keyExtractor)).toContain(stableKey);
    expect(mockFlatListState.props?.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0,
      autoscrollToTopThreshold: 10,
    });
    expect(mockFlatListState.scrollToOffset).not.toHaveBeenCalled();
  }

  function dataKeys(): string[] {
    return (mockFlatListState.props?.data as ChatRenderItem[]).map(
      (item) => item.key,
    );
  }

  function summaryKeysFor(rowKey: string): string[] {
    const row = (mockFlatListState.props?.data as ChatRenderItem[]).find(
      (item) => item.key === rowKey,
    );
    if (row?.kind !== 'event' && row?.kind !== 'tool') return [];
    return row.summaries?.map((summary) => summary.key) ?? [];
  }

  it('과거 읽기에서 live summary와 reload가 stable key·MVCP를 전달하고 강제 스크롤하지 않는다', () => {
    const base = [
      ev('2', 'assistant_message', { text: '과거 응답' }),
      ev('3', 'complete'),
      ev('10', 'user_message', { text: '최신 질문' }),
    ];
    const summary = ev('40', 'turn_summary', {
      content: '늦은 과거 요약',
      final_response_event_id: 2,
      parent_event_id: 2,
    });
    const view = render(<Harness events={base} />);
    flushFrames();
    enterHistoryReading('evt-2', 240);
    const beforeKeys = dataKeys();

    view.rerender(<Harness events={[...base, summary]} />);
    act(() => mockFlatListState.props?.onContentSizeChange?.(0, 520));

    expect(dataKeys()).toEqual(beforeKeys);
    expect(dataKeys()).toHaveLength(3);
    expect(summaryKeysFor('evt-2')).toEqual(['turn-summary-40']);
    expectHistoryProductContract('evt-2');

    view.rerender(
      <Harness
        events={[
          ev('2', 'assistant_message', { text: '과거 응답' }),
          ev('3', 'complete'),
          ev('10', 'user_message', { text: '최신 질문' }),
          ev('40', 'turn_summary', {
            content: '늦은 과거 요약',
            final_response_event_id: 2,
            parent_event_id: 2,
          }),
        ]}
      />,
    );
    act(() => mockFlatListState.props?.onContentSizeChange?.(0, 520));
    expect(dataKeys()).toEqual(beforeKeys);
    expect(summaryKeysFor('evt-2')).toEqual(['turn-summary-40']);
    expectHistoryProductContract('evt-2');
  });

  it('미로딩 summary는 무변화이고 anchor prepend 뒤에도 stable key·MVCP 계약을 보존한다', () => {
    const summary = ev('40', 'turn_summary', {
      content: '페이지 경계 요약',
      final_response_event_id: 2,
      parent_event_id: 2,
    });
    const recent = ev('10', 'user_message', { text: '최신 질문' });
    const view = render(<Harness events={[recent, summary]} />);
    flushFrames();
    enterHistoryReading('evt-10', 180);

    expect(dataKeys()).toEqual(['evt-10']);
    view.rerender(
      <Harness
        events={[
          ev('2', 'assistant_message', { text: '과거 응답' }),
          ev('3', 'complete'),
          recent,
          summary,
        ]}
      />,
    );
    act(() => mockFlatListState.props?.onContentSizeChange?.(0, 480));

    expect(dataKeys()).toEqual(['evt-10', 'evt-3', 'evt-2']);
    expect(summaryKeysFor('evt-2')).toEqual(['turn-summary-40']);
    expectHistoryProductContract('evt-10');
  });

  it('bottom에서는 같은 anchor 행의 key·길이를 유지하고 기존 follow 명령만 보낸다', () => {
    const base = [
      ev('2', 'assistant_message'),
      ev('3', 'complete'),
      ev('10', 'user_message'),
    ];
    const view = render(<Harness events={base} />);
    flushFrames();
    mockFlatListState.scrollToOffset.mockClear();
    act(() => mockFlatListState.props?.onScroll?.({
      nativeEvent: { contentOffset: { y: 0 } },
    } as NativeSyntheticEvent<NativeScrollEvent>));
    const beforeKeys = dataKeys();

    view.rerender(
      <Harness
        events={[
          ...base,
          ev('40', 'turn_summary', {
            content: '과거 요약',
            final_response_event_id: 2,
          }),
        ]}
      />,
    );
    act(() => mockFlatListState.props?.onContentSizeChange?.(0, 520));
    flushFrames();

    expect(dataKeys()).toEqual(beforeKeys);
    expect(summaryKeysFor('evt-2')).toEqual(['turn-summary-40']);
    expect(mockFlatListState.scrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
  });

  it('bottom에서 미로딩 summary는 무변화이고 anchor prepend 뒤에만 follow한다', () => {
    const recent = ev('10', 'user_message');
    const summary = ev('40', 'turn_summary', {
      content: '페이지 경계 요약',
      final_response_event_id: 2,
    });
    const view = render(<Harness events={[recent]} />);
    flushFrames();
    mockFlatListState.scrollToOffset.mockClear();
    act(() => mockFlatListState.props?.onScroll?.({
      nativeEvent: { contentOffset: { y: 0 } },
    } as NativeSyntheticEvent<NativeScrollEvent>));

    view.rerender(<Harness events={[recent, summary]} />);
    expect(dataKeys()).toEqual(['evt-10']);
    expect(mockFlatListState.scrollToOffset).not.toHaveBeenCalled();

    view.rerender(
      <Harness
        events={[
          ev('2', 'assistant_message'),
          ev('3', 'complete'),
          recent,
          summary,
        ]}
      />,
    );
    act(() => mockFlatListState.props?.onContentSizeChange?.(0, 520));
    flushFrames();

    expect(dataKeys()).toEqual(['evt-10', 'evt-3', 'evt-2']);
    expect(summaryKeysFor('evt-2')).toEqual(['turn-summary-40']);
    expect(mockFlatListState.scrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
  });

  it('inverted FlatList의 composite 행 내부는 응답 뒤에 summary를 event ID 순서로 렌더한다', () => {
    render(
      <Harness
        events={[
          ev('2', 'assistant_message', { text: '응답' }),
          ev('41', 'turn_summary', {
            content: '둘째',
            final_response_event_id: 2,
          }),
          ev('40', 'turn_summary', {
            content: '첫째',
            final_response_event_id: 2,
          }),
        ]}
      />,
    );

    expect(dataKeys()).toEqual(['evt-2']);
    expect(summaryKeysFor('evt-2')).toEqual([
      'turn-summary-40',
      'turn-summary-41',
    ]);
    expect(mockRenderOrder).toEqual([
      'event:2',
      'summary:첫째',
      'summary:둘째',
    ]);
  });

  it('session switch는 이전 summary key를 섞지 않고 새 viewport를 bottom으로 reset한다', () => {
    const view = render(
      <Harness
        events={[
          ev('2', 'assistant_message'),
          ev('40', 'turn_summary', {
            content: 'A 요약',
            final_response_event_id: 2,
          }),
        ]}
      />,
    );
    flushFrames();
    mockFlatListState.scrollToOffset.mockClear();

    view.rerender(
      <Harness sessionId="sess-b" events={[ev('100', 'user_message')]} />,
    );
    flushFrames();

    expect(dataKeys()).toEqual(['evt-100']);
    expect(mockFlatListState.scrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
  });
});
