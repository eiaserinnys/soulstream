import { act, renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { groupChatEvents } from '../groupChatEvents';
import { findChatRenderItemKeyForEvent } from '../chatSearchAnchor';
import { useChatRenderItems } from '../useChatRenderItems';

function event(
  id: string,
  type: string,
  source?: string,
): SessionEvent {
  return {
    id,
    type: type as SessionEvent['type'],
    data: {
      text: `메시지 ${id}`,
      ...(source ? { caller_info: { source, display_name: `${source} 발신` } } : {}),
    },
  };
}

function renderItems(events: SessionEvent[], presentation: 'default' | 'manuscript' = 'manuscript') {
  return useChatRenderItems({
    events,
    pendingOptimistic: undefined,
    streamingSlots: undefined,
    sessionStatus: 'completed',
    presentation,
  });
}

function chronological(items: ReturnType<typeof renderItems>['reversedItems']) {
  return [...items].reverse();
}

function groups(items: ReturnType<typeof chronological>) {
  return items.filter(item => (item.kind as string) === 'agent-message-group') as Array<{
    kind: 'agent-message-group';
    key: string;
    events: Array<{ event: SessionEvent; key: string }>;
  }>;
}

describe('manuscript agent message groups', () => {
  test('three consecutive agent user messages and interventions become one collapsed row', () => {
    const input = [
      event('1', 'user_message', 'agent'),
      event('2', 'intervention_sent', 'agent'),
      event('3', 'user_message', 'agent'),
    ];

    const { result } = renderHook(() => renderItems(input));
    const items = chronological(result.current.reversedItems);

    expect(items).toHaveLength(1);
    expect(groups(items)[0].events.map(row => row.event.id)).toEqual(['1', '2', '3']);
    expect(findChatRenderItemKeyForEvent(items, 2)).toBe(groups(items)[0].key);
  });

  test('a visible person or system row splits agent groups and remains visible', () => {
    const input = [
      event('1', 'user_message', 'agent'),
      event('2', 'user_message', 'browser'),
      event('3', 'intervention_sent', 'agent'),
      event('4', 'system', 'agent'),
      event('5', 'user_message', 'agent'),
    ];

    const { result } = renderHook(() => renderItems(input));
    const items = chronological(result.current.reversedItems);

    expect(items.map(item => item.kind)).toEqual([
      'agent-message-group', 'event', 'agent-message-group', 'event', 'agent-message-group',
    ]);
    expect(groups(items).map(group => group.events.length)).toEqual([1, 1, 1]);
    expect(items[1]).toMatchObject({ kind: 'event', event: { id: '2', type: 'user_message' } });
    expect(items[3]).toMatchObject({ kind: 'event', event: { id: '4', type: 'system' } });
  });

  test('a late agent message extends the last group with the same row key', () => {
    const firstPage = [
      event('1', 'user_message', 'agent'),
      event('2', 'user_message', 'browser'),
      event('3', 'user_message', 'agent'),
    ];
    const { result, rerender } = renderHook(
      ({ events }) => renderItems(events),
      { initialProps: { events: firstPage } },
    );
    const firstLastGroup = groups(chronological(result.current.reversedItems))[1];

    act(() => rerender({ events: [...firstPage, event('4', 'intervention_sent', 'agent')] }));

    const nextGroups = groups(chronological(result.current.reversedItems));
    expect(nextGroups[1].key).toBe(firstLastGroup.key);
    expect(nextGroups[1].events.map(row => row.event.id)).toEqual(['3', '4']);
  });

  test('default chat keeps the existing event rows without grouping', () => {
    const input = [event('1', 'user_message', 'agent'), event('2', 'user_message', 'browser')];
    const { result } = renderHook(() => renderItems(input, 'default'));

    expect(result.current.reversedItems).toEqual(groupChatEvents(input).reverse());
  });
});
