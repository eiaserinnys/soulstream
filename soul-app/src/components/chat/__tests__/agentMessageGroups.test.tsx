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

describe('manuscript agent message groups', () => {
  test('consecutive agent user messages and interventions disappear', () => {
    const input = [
      event('1', 'user_message', 'agent'),
      event('2', 'intervention_sent', 'agent'),
      event('3', 'user_message', 'agent'),
    ];

    const { result } = renderHook(() => renderItems(input));
    const items = chronological(result.current.reversedItems);

    expect(items).toEqual([]);
    expect([1, 2, 3].map(id => findChatRenderItemKeyForEvent(items, id))).toEqual([
      null, null, null,
    ]);
  });

  test('visible person and system rows remain while agent messages disappear', () => {
    const input = [
      event('1', 'user_message', 'agent'),
      event('2', 'user_message', 'browser'),
      event('3', 'intervention_sent', 'agent'),
      event('4', 'system', 'agent'),
      event('5', 'user_message', 'agent'),
    ];

    const { result } = renderHook(() => renderItems(input));
    const items = chronological(result.current.reversedItems);

    expect(items.map(item => item.kind)).toEqual(['event', 'event']);
    expect(items).toMatchObject([
      { kind: 'event', event: { id: '2', type: 'user_message' } },
      { kind: 'event', event: { id: '4', type: 'system' } },
    ]);
  });

  test('a late agent message leaves the remaining rows and keys unchanged', () => {
    const firstPage = [
      event('1', 'user_message', 'agent'),
      event('2', 'user_message', 'browser'),
      event('3', 'user_message', 'agent'),
      event('4', 'system', 'agent'),
    ];
    const { result, rerender } = renderHook<
      ReturnType<typeof renderItems>,
      { events: SessionEvent[] }
    >(
      ({ events }) => renderItems(events),
      { initialProps: { events: firstPage } },
    );
    const firstItems = chronological(result.current.reversedItems);
    const firstRows = firstItems.map(item => ({
      kind: item.kind,
      eventId: item.kind === 'event' ? item.event.id : null,
      key: item.key,
    }));

    act(() => rerender({ events: [...firstPage, event('5', 'intervention_sent', 'agent')] }));

    const nextItems = chronological(result.current.reversedItems);
    const nextRows = nextItems.map(item => ({
      kind: item.kind,
      eventId: item.kind === 'event' ? item.event.id : null,
      key: item.key,
    }));
    expect(firstRows).toMatchObject([
      { kind: 'event', eventId: '2' },
      { kind: 'event', eventId: '4' },
    ]);
    expect(nextRows).toEqual(firstRows);
    expect(findChatRenderItemKeyForEvent(nextItems, 2)).toBe(
      findChatRenderItemKeyForEvent(firstItems, 2),
    );
    expect(findChatRenderItemKeyForEvent(nextItems, 4)).toBe(
      findChatRenderItemKeyForEvent(firstItems, 4),
    );
  });

  test('default chat keeps the existing event rows without grouping', () => {
    const input = [event('1', 'user_message', 'agent'), event('2', 'user_message', 'browser')];
    const { result } = renderHook(() => renderItems(input, 'default'));

    expect(result.current.reversedItems).toEqual(groupChatEvents(input).reverse());
  });
});
