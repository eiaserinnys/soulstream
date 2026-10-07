import { act, renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import type { StreamingSlots } from '../../../store/chatStore';
import { useChatRenderItems } from '../useChatRenderItems';

const CACHE_KEEPALIVE_PURPOSE = 'cache_keepalive';

const event = (
  id: string,
  type: SessionEvent['type'],
  data: Record<string, unknown> = {},
): SessionEvent => ({ id, type, data });

function sourceEventIds(items: ReturnType<typeof useChatRenderItems>['reversedItems']): string[] {
  return items.flatMap((item) => {
    if (
      item.kind === 'event'
      || item.kind === 'turn-summary'
      || item.kind === 'turn-usage'
      || item.kind === 'turn-end-captions'
    ) {
      return [item.event.id];
    }
    if (item.kind === 'tool') return [item.start.id, ...(item.result ? [item.result.id] : [])];
    if (item.kind === 'agent-message-group') return item.events.map(({ event: grouped }) => grouped.id);
    return [];
  });
}

const humanTurn = [
  event('1', 'user_message', { text: '일반 입력' }),
  event('2', 'assistant_message', { text: '사람 턴 답변' }),
  event('3', 'complete', { turn_cost_usd: 0.4, session_cost_usd: 12.4 }),
];

const keepaliveTurn = [
  event('4', 'user_message', {
    text: '캐시 유지용 호출입니다. 도구를 쓰지 말고 \'ok\'만 답하십시오.',
    input_id: 'keepalive-input',
    purpose: CACHE_KEEPALIVE_PURPOSE,
  }),
  event('5', 'assistant_message', { text: 'ok' }),
  event('6', 'generation_started', { context_reset: true }),
  event('7', 'complete', { turn_cost_usd: 0.01, session_cost_usd: 12.41 }),
  event('8', 'debug', {
    kind: 'persistent_instruction_recorded',
    input_id: 'keepalive-input',
    instructions: [{ id: 'instruction-1', text: 'hidden caption', source_turns: ['T12'], action: 'added' }],
    cap_reached: false,
  }),
];

const sameTurnWithoutMarker = keepaliveTurn.map((item) => item.id === '4'
  ? { ...item, data: { ...item.data, purpose: undefined } }
  : item);

const sameTextHumanTurn = [
  event('9', 'user_message', {
    text: '캐시 유지용 호출입니다. 도구를 쓰지 말고 \'ok\'만 답하십시오.',
    input_id: 'human-input',
  }),
  event('10a', 'context_usage', { used_tokens: 50, max_tokens: 100, percent: 50 }),
  event('10', 'assistant_message', { text: '사람이 보낸 같은 문구의 답변' }),
  event('11', 'complete', { turn_cost_usd: 0.2, session_cost_usd: 12.61 }),
];

function renderItems(events: SessionEvent[], streamingSlots?: StreamingSlots) {
  return useChatRenderItems({
    events,
    pendingOptimistic: undefined,
    streamingSlots,
    sessionStatus: 'completed',
    presentation: 'manuscript',
    persistentDisplaySettings: { showGenerationSeparator: true, showJevCandidates: false },
    showTurnUsage: true,
  });
}

test('the H3 instruction caption is attached to the cache turn before its marker is projected', () => {
  const { result } = renderHook(() => renderItems([...humanTurn, ...sameTurnWithoutMarker]));
  const caption = result.current.reversedItems.find((item) => (
    item.kind === 'turn-end-captions' && item.event.id === '7'
  ));

  expect(caption).toMatchObject({
    kind: 'turn-end-captions',
    persistentInstructionRecorded: {
      instructions: [{ id: 'instruction-1', text: 'hidden caption', source_turns: ['T12'] }],
      capReached: false,
    },
  });
});

test('the chat projection hides a keepalive turn and its H3 caption while preserving neighboring human turns', () => {
  const events = [...humanTurn, ...keepaliveTurn, ...sameTextHumanTurn];
  const { result } = renderHook(() => renderItems(events));
  const ids = sourceEventIds(result.current.reversedItems);

  expect(ids).toEqual(expect.arrayContaining(['1', '2', '3', '9', '10', '11']));
  expect(ids).not.toEqual(expect.arrayContaining(['4', '5', '6', '7', '8']));
  expect(events.some((item) => item.id === '7' && item.data.turn_cost_usd === 0.01)).toBe(true);
  expect(result.current.reversedItems.some((item) => (
    item.kind === 'turn-end-captions' && item.event.id === '11' && item.usage?.title.includes('$0.20')
  ))).toBe(true);
  const nextTurnUsage = result.current.reversedItems.find((item) => (
    item.kind === 'turn-end-captions' && item.event.id === '11'
  ));
  expect(nextTurnUsage?.kind === 'turn-end-captions' ? nextTurnUsage.usage?.lines.join(' ') : '')
    .toContain('세션 $12.61');
  expect(result.current.reversedItems.some((item) => (
    item.kind === 'turn-end-captions' && 'persistentInstructionRecorded' in item
  ))).toBe(false);
});

test('an unmarked input with the keepalive prompt text remains in the chat projection', () => {
  const { result } = renderHook(() => renderItems(sameTextHumanTurn));

  expect(sourceEventIds(result.current.reversedItems)).toEqual(expect.arrayContaining(['9', '10', '11']));
});

test('an intervention_sent keepalive input also removes the full turn span', () => {
  const events = [
    ...humanTurn,
    event('12', 'intervention_sent', {
      text: '캐시 유지용 호출입니다. 도구를 쓰지 말고 \'ok\'만 답하십시오.',
      input_id: 'intervention-keepalive',
      purpose: CACHE_KEEPALIVE_PURPOSE,
    }),
    event('13', 'assistant_message', { text: 'ok' }),
    event('14', 'complete', { turn_cost_usd: 0.01 }),
    event('15', 'debug', {
      kind: 'persistent_instruction_recorded',
      input_id: 'intervention-keepalive',
      instructions: [{ id: 'instruction-2', text: 'hidden caption', source_turns: ['T12'], action: 'added' }],
      cap_reached: false,
    }),
  ];
  const { result } = renderHook(() => renderItems(events));
  const ids = sourceEventIds(result.current.reversedItems);

  expect(ids).not.toEqual(expect.arrayContaining(['12', '13', '14', '15']));
});

test('an active keepalive turn hides its streaming answer and does not create a new-message row', () => {
  const liveAnswer = event('live-keepalive', 'assistant_message', { text: 'ok' });
  const { result } = renderHook(() => renderItems(
    [...humanTurn, keepaliveTurn[0]!],
    { assistant: liveAnswer },
  ));

  expect(sourceEventIds(result.current.reversedItems)).not.toContain('live-keepalive');
  expect(result.current.reversedItems.some((item) => item.kind === 'typing')).toBe(false);
  expect(result.current.bottomFollowItemKey).toBe('evt-3');
});

test('a keepalive-only append does not change the manuscript bottom key used by the new-message button', () => {
  const { result, rerender } = renderHook(
    ({ events }: { events: SessionEvent[] }) => renderItems(events),
    { initialProps: { events: humanTurn } },
  );
  const previousBottomKey = result.current.bottomFollowItemKey;

  act(() => rerender({ events: [...humanTurn, ...keepaliveTurn] }));

  expect(result.current.bottomFollowItemKey).toBe(previousBottomKey);
  expect(sourceEventIds(result.current.reversedItems)).not.toEqual(expect.arrayContaining(['4', '5', '7', '8']));
});
