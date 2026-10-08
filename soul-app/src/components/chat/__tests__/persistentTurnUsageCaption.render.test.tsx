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

function chatList(events: SessionEvent[], mode: 'collapsed' | 'expanded' | 'hidden') {
  const items = projectPersistentTurnUsage(groupChatEvents(events), events, mode as never);
  return <ChatEventList
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
    />;
}

function renderCompletion(data: Record<string, unknown>, mode: 'collapsed' | 'expanded' | 'hidden' = 'collapsed') {
  return render(chatList([{ id: '1', type: 'complete', data }], mode));
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

test('error usage follows mode updates without remounting the error row', () => {
  const events: SessionEvent[] = [
    { id: '10', type: 'context_usage', data: { used_tokens: 41_500, max_tokens: 100_000, percent: 41.5 } },
    { id: '11', type: 'error', data: { message: '오류 본문 유지' } },
  ];
  const screen = render(chatList(events, 'collapsed'));
  const usageHead = screen.getByRole('button', { name: '컨텍스트 41.5%' });
  expect(usageHead.props.accessibilityState.expanded).toBe(false);

  screen.rerender(chatList(events, 'expanded'));
  expect(screen.getByRole('button', { name: '컨텍스트 41.5%' }).props.accessibilityState.expanded).toBe(true);

  screen.rerender(chatList(events, 'collapsed'));
  expect(screen.getByRole('button', { name: '컨텍스트 41.5%' }).props.accessibilityState.expanded).toBe(false);
});
