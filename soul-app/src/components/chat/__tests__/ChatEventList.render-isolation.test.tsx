import React, { useRef } from 'react';
import { act, render } from '@testing-library/react-native';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { StreamingSlots } from '../../../store/chatStore';
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
jest.mock('../../events/ToolEvent', () => ({ ToolEvent: ({ start }: {start: SessionEvent}) => { mockRenderOrder.push(`tool:${start.id}`); return null; } }));
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

const noop = () => {};
function Harness({
  events,
  sessionId = 'sess-a',
  streamingSlots,
}: {
  events: SessionEvent[];
  sessionId?: string;
  streamingSlots?: StreamingSlots;
}) {
  const flatListRef = useRef<FlatList<ChatRenderItem> | null>(null);
  const { reversedItems, bottomFollowItemKey } = useChatRenderItems({
    events,
    pendingOptimistic: undefined,
    streamingSlots,
    sessionStatus: 'running',
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
      requestOlder={noop}
      onScroll={(event) =>
        follow.onScrollOffsetChange(event.nativeEvent.contentOffset.y)
      }
      onScrollBeginDrag={follow.onScrollBeginDrag}
      historyLoading={false}
      reachedTop={false}
      hasFetchError={false}
      retryFromError={noop}
      mvcpEnabled
      onContentSizeChange={follow.onContentSizeChange}
    />
  );
}

describe('chat row render isolation', () => {
  const base = [ev('1', 'user_message', { text: '질문' }), ev('2', 'assistant_message', { text: '이전 답변' }),
    ev('3', 'tool_start', { tool_use_id: 'tool-a', tool_name: 'exec_command' })];
  beforeEach(() => { mockRenderOrder.length = 0; });

  it('text delta renders only its streaming row, retaining every history row', () => {
    const stream = (text: string) => ({ assistant: ev('live', 'assistant_message', { text, streamIdentity: 'live' }) });
    const view = render(<Harness events={base} streamingSlots={stream('첫 조각')} />);
    mockRenderOrder.length = 0;
    view.rerender(<Harness events={base} streamingSlots={stream('첫 조각 다음 조각')} />);
    expect(mockRenderOrder).toEqual(['event:live']);
  });

  it('tool result renders only the matched tool row', () => {
    const view = render(<Harness events={base} />);
    mockRenderOrder.length = 0;
    view.rerender(<Harness events={[...base, ev('4', 'tool_result', { tool_use_id: 'tool-a', result: '결과' })]} />);
    expect(mockRenderOrder).toEqual(['tool:3']);
  });

  it('inserting a tool row preserves the identities and renders of all existing rows', () => {
    const view = render(<Harness events={base} />);
    mockRenderOrder.length = 0;
    view.rerender(<Harness events={[...base, ev('5', 'tool_start', { tool_use_id: 'tool-b', tool_name: 'exec_command' })]} />);
    expect(mockRenderOrder).toEqual(['tool:5']);
  });
});
