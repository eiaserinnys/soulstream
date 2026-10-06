import React, { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import type { FlatList } from 'react-native';
import type { SessionEvent } from '../../../api/types';
import type { ChatBodyStyles } from '../ChatBody.styles';
import type { ChatRenderItem } from '../groupChatEvents';
import { ChatEventList } from '../ChatEventList';
import { groupChatEvents } from '../groupChatEvents';
import { projectPersistentTurnUsage } from '../persistentTurnUsageProjection';

jest.mock('../../events/EventRenderer', () => ({ EventRenderer: () => null }));
jest.mock('../../events/EventContextMenu', () => ({
  EventContextMenu: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../events/ToolEvent', () => ({ ToolEvent: () => null }));
jest.mock('../../events/TurnSummaryCaption', () => ({ TurnSummaryCaption: () => null }));
jest.mock('../TypingIndicator', () => ({ TypingIndicator: () => null }));
jest.mock('../HistoryFetchError', () => ({ HistoryFetchError: () => null }));

const noop = () => {};
const styles = { list: {}, listContent: {} } as ChatBodyStyles;

function renderCompletion(data: Record<string, unknown>) {
  const events: SessionEvent[] = [{ id: '1', type: 'complete', data }];
  const items = projectPersistentTurnUsage(groupChatEvents(events), events);
  return render(
    <ChatEventList
      flatListRef={createRef<FlatList<ChatRenderItem> | null>()}
      items={items}
      session={undefined}
      sessionId="render-test"
      api={null}
      styles={styles}
      accentColor="#000000"
      requestOlder={noop}
      onScroll={noop}
      onScrollBeginDrag={noop}
      historyLoading={false}
      reachedTop
      hasFetchError={false}
      retryFromError={noop}
      mvcpEnabled={false}
      onContentSizeChange={noop}
      presentation="manuscript"
    />,
  );
}

test.each([
  {
    title: '정가 $0.80',
    expanded: '턴 완료 · 정가 $0.80',
    data: { turn_cost_usd: 0.8 },
  },
  {
    title: '입력 150 · 출력 35',
    expanded: '턴 완료 · 입력 150 · 출력 35',
    data: { usage: { input_tokens: 150, output_tokens: 35 } },
  },
  {
    title: '정가 $0.00',
    expanded: '턴 완료 · 정가 $0.00',
    data: { turn_cost_usd: 0 },
  },
])('$title 펼침은 전체 문구를 한 번만 보인다', ({ title, expanded, data }) => {
  const screen = renderCompletion(data);
  const caption = screen.getByRole('button', { name: title });

  expect(screen.getByText(title)).toBeTruthy();
  expect(screen.queryByText(expanded)).toBeNull();
  fireEvent.press(caption);

  expect(screen.queryByText(title)).toBeNull();
  expect(screen.getAllByText(expanded)).toHaveLength(1);
});
