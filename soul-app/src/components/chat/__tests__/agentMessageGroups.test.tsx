import { act, renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { groupChatEvents } from '../groupChatEvents';
import { findChatRenderItemKeyForEvent } from '../chatSearchAnchor';
import { useChatRenderItems } from '../useChatRenderItems';
import { useChatStore } from '../../../store/chatStore';
import { streamingSlotTransitionForEvent } from '../streamingDeltaBuffer';

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

function renderItems(
  events: SessionEvent[],
  presentation: 'default' | 'manuscript' = 'manuscript',
  streamingSlots?: ReturnType<typeof useChatStore.getState>['streamingSlotsBySession'][string],
) {
  return useChatRenderItems({
    events,
    pendingOptimistic: undefined,
    streamingSlots,
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

  test('PAS stale stream A never enters the transcript and next-turn delta D renders after B and C', () => {
    const sessionId = 'pas-interrupted-stream-846';
    const store = useChatStore.getState();
    const previewA: SessionEvent = {
      id: 'live:stream-a',
      type: 'text_delta',
      data: { text: 'stale A', _live_only: true, streamIdentity: 'stream-a' },
    };
    store.setStreamingEvent(sessionId, 'assistant', previewA);

    // A structural event finalizes pending slots. A live preview remains owned by
    // the streaming slot until an explicit lifecycle fence clears it.
    store.finalizeStreamingEvent(sessionId, 'assistant');
    expect(useChatStore.getState().eventsBySession[sessionId] ?? []).toEqual([]);
    expect(useChatStore.getState().streamingSlotsBySession[sessionId]?.assistantByStream?.['stream-a'])
      .toEqual(previewA);

    const intervention = streamingSlotTransitionForEvent('intervention_sent', {});
    intervention.clear.forEach(kind => store.clearStreamingEvent(sessionId, kind));
    intervention.finalize.forEach(kind => store.finalizeStreamingEvent(sessionId, kind));
    const rows: SessionEvent[] = [
      { id: '64838', type: 'intervention_sent', data: { text: '개입' } },
      { id: '64840', type: 'assistant_message', data: { content: 'final B' } },
      { id: '64841', type: 'complete', data: { result: 'done' } },
      { id: '64842', type: 'session_ended', data: { status: 'completed', termination_reason: 'completed_ok' } },
      { id: '64849', type: 'user_message', data: { text: '다음 질문', caller_info: { source: 'browser' } } },
      { id: '64856', type: 'assistant_message', data: { content: 'final C' } },
    ];
    for (const row of rows) {
      if (row.type === 'complete' || row.type === 'session_ended' || row.type === 'user_message') {
        const transition = streamingSlotTransitionForEvent(row.type, row.data);
        transition.clear.forEach(kind => store.clearStreamingEvent(sessionId, kind));
        transition.finalize.forEach(kind => store.finalizeStreamingEvent(sessionId, kind));
      }
      store.mergeEvents(sessionId, [row]);
    }
    store.setStreamingEvent(sessionId, 'assistant', {
      id: 'live:stream-d',
      type: 'text_delta',
      data: { text: 'fresh D', _live_only: true, streamIdentity: 'stream-d' },
    });

    const state = useChatStore.getState();
    const { result } = renderHook(() => renderItems(
      state.eventsBySession[sessionId] ?? [],
      'manuscript',
      state.streamingSlotsBySession[sessionId],
    ));
    const items = chronological(result.current.reversedItems);
    const rendered = JSON.stringify(items);

    expect(rendered).not.toContain('stale A');
    expect(rendered).toContain('final B');
    expect(rendered).toContain('final C');
    expect(rendered).toContain('fresh D');
  });
});
