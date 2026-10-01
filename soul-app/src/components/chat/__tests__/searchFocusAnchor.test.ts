import type { ChatRenderItem } from '../groupChatEvents';
import { findChatRenderItemKeyForEvent } from '../chatSearchAnchor';

test('본문 검색 anchor는 일반 발화, tool result, turn summary가 속한 렌더 행을 찾는다', () => {
  const items: ChatRenderItem[] = [
    {
      kind: 'event',
      key: 'evt-10',
      event: { id: '10', type: 'assistant_message', data: {} },
      summaries: [
        {
          kind: 'turn-summary',
          key: 'turn-summary-30',
          event: { id: '30', type: 'turn_summary', data: {} },
          content: '응답에 결합된 요약',
          anchorEventId: 10,
        },
      ],
    },
    {
      kind: 'tool',
      key: 'tool-20',
      start: { id: '20', type: 'tool_start', data: {} },
      result: { id: '21', type: 'tool_result', data: {} },
    },
    {
      kind: 'turn-summary',
      key: 'turn-summary-40',
      event: { id: '40', type: 'turn_summary', data: {} },
      content: 'legacy 요약',
      anchorEventId: 40,
    },
  ];

  expect(findChatRenderItemKeyForEvent(items, 10)).toBe('evt-10');
  expect(findChatRenderItemKeyForEvent(items, 21)).toBe('tool-20');
  expect(findChatRenderItemKeyForEvent(items, 30)).toBe('evt-10');
  expect(findChatRenderItemKeyForEvent(items, 40)).toBe('turn-summary-40');
  expect(findChatRenderItemKeyForEvent(items, 99)).toBeNull();
});
