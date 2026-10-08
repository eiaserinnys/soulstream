import { act, renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import type { StreamingSlots } from '../../../store/chatStore';
import { persistentJevCandidatesFixture } from '../../../component-review/persistentJevCandidatesFixture';
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
  event('5', 'generation_started', { context_reset: true }),
  event('6', 'assistant_message', { text: 'ok' }),
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
    turnUsageMode: 'collapsed',
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

test('the chat projection hides a keepalive turn and its H3 caption while preserving dividers and neighboring human turns', () => {
  const events = [...humanTurn, ...keepaliveTurn, ...sameTextHumanTurn];
  const { result } = renderHook(() => renderItems(events));
  const ids = sourceEventIds(result.current.reversedItems);

  expect(ids).toEqual(expect.arrayContaining(['1', '2', '3', '9', '10', '11']));
  expect(ids).not.toEqual(expect.arrayContaining(['4', '6', '7', '8']));
  expect(ids).toContain('5');
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

test('an active keepalive turn hides its streaming answer through generation_started and does not create a new-message row', () => {
  const liveAnswer = event('live-keepalive', 'assistant_message', { text: 'ok' });
  const { result } = renderHook(() => renderItems(
    [...humanTurn, keepaliveTurn[0]!, keepaliveTurn[1]!],
    { assistant: liveAnswer },
  ));

  expect(sourceEventIds(result.current.reversedItems)).toContain('5');
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

test('a divider after keepalive complete stays visible and the following human turn is unchanged', () => {
  const events = [
    event('20', 'user_message', { input_id: 'keepalive-after-complete', text: '유지 턴', purpose: CACHE_KEEPALIVE_PURPOSE }),
    event('21', 'assistant_message', { text: 'ok' }),
    event('22', 'complete', { turn_cost_usd: 0.01, session_cost_usd: 12.42 }),
    event('23', 'generation_started', { context_reset: true }),
    event('24', 'user_message', { input_id: 'human-after-complete', text: '사람 입력' }),
    event('25', 'assistant_message', { text: '사람 답' }),
    event('26', 'complete', { turn_cost_usd: 0.2, session_cost_usd: 12.62 }),
  ];
  const { result } = renderHook(() => renderItems(events));
  const ids = sourceEventIds(result.current.reversedItems);

  expect(ids).toEqual(expect.arrayContaining(['23', '24', '25', '26']));
  expect(ids).not.toEqual(expect.arrayContaining(['20', '21', '22']));
});

test('unanchored post-terminal rows stay visible while H3 and Jev rows anchored to keepalive stay hidden', () => {
  const events = [
    event('30', 'user_message', { input_id: 'keepalive-anchor', text: '유지 턴', purpose: CACHE_KEEPALIVE_PURPOSE }),
    event('31', 'assistant_message', { text: 'ok' }),
    event('32', 'complete', { turn_cost_usd: 0.01 }),
    event('33', 'system', { text: 'unanchored after complete' }),
    event('34', 'debug', {
      kind: 'persistent_instruction_recorded',
      input_id: 'keepalive-anchor',
      instructions: [{ id: 'instruction-keepalive', text: 'hidden caption', source_turns: ['T12'], action: 'added' }],
      cap_reached: false,
    }),
    persistentJevCandidatesFixture('35', 'keepalive-anchor', { selectedCount: 2 }),
    event('36', 'user_message', { input_id: 'human-anchor', text: '사람 입력' }),
  ];
  const { result } = renderHook(() => renderItems(events));
  const ids = sourceEventIds(result.current.reversedItems);

  expect(ids).toContain('33');
  expect(ids).toContain('36');
  expect(ids).not.toEqual(expect.arrayContaining(['30', '31', '32', '34', '35']));
  expect(result.current.reversedItems.some((item) => item.kind === 'jev-candidates')).toBe(false);
  expect(result.current.reversedItems.some((item) => item.kind === 'turn-end-captions' && item.persistentInstructionRecorded)).toBe(false);
});

test('a keepalive error remains visible while its input stays hidden', () => {
  const events = [
    event('40', 'user_message', { input_id: 'keepalive-error', text: '유지 턴', purpose: CACHE_KEEPALIVE_PURPOSE }),
    event('41', 'error', { error: '한도 초과', error_code: 'billing_error' }),
  ];
  const { result } = renderHook(() => renderItems(events));
  const ids = sourceEventIds(result.current.reversedItems);

  expect(ids).toContain('41');
  expect(ids).not.toContain('40');
});

test('generation_started stays visible while the keepalive turn remains active without a terminal event', () => {
  const events = [
    event('50', 'user_message', { input_id: 'keepalive-open', text: '유지 턴', purpose: CACHE_KEEPALIVE_PURPOSE }),
    event('51', 'system', { text: 'inside open keepalive turn' }),
    event('52', 'generation_started', { context_reset: true }),
  ];
  const { result } = renderHook(() => renderItems(events));
  const ids = sourceEventIds(result.current.reversedItems);

  expect(ids).toContain('52');
  expect(ids).not.toEqual(expect.arrayContaining(['50', '51']));
});
