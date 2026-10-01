import {
  groupChatEvents,
  hasActiveStreamingAssistantText,
  placePendingOptimistic,
  streamingSlotRenderItems,
  toSessionEvent,
} from '../groupChatEvents';
import type { SessionEvent } from '../../../api/types';
import { createOptimisticUserEvent } from '../../../store/chatStore';

const ev = (id: string, type: SessionEvent['type'], data: any = {}): SessionEvent => ({
  id,
  type,
  data,
});

describe('groupChatEvents', () => {
  it('빈 events 배열은 빈 배열을 반환한다', () => {
    expect(groupChatEvents([])).toEqual([]);
  });

  it('일반 이벤트(user_message, assistant_message)는 kind=event로 변환한다', () => {
    const events = [
      ev('1', 'user_message', { text: 'hi' }),
      ev('2', 'assistant_message', { text: 'hello' }),
    ];
    const result = groupChatEvents(events);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ kind: 'event', event: events[0], key: 'evt-1' });
    expect(result[1]).toEqual({ kind: 'event', event: events[1], key: 'evt-2' });
  });

  it('tool_start와 같은 tool_use_id의 tool_result는 단일 그룹으로 묶는다 (핵심 매칭)', () => {
    const start = ev('10', 'tool_start', { tool_use_id: 'tu_a' });
    const result = ev('11', 'tool_result', { tool_use_id: 'tu_a', output: 'ok' });
    const out = groupChatEvents([start, result]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: 'tool',
      start,
      result,
      key: 'tool-10',
    });
  });

  it('tool_start의 tool_use_id가 data.id 키에 있어도 매칭한다 (id fallback)', () => {
    const start = ev('20', 'tool_start', { id: 'tu_b' });
    const result = ev('21', 'tool_result', { tool_use_id: 'tu_b' });
    const out = groupChatEvents([start, result]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('tool');
    if (out[0].kind === 'tool') {
      expect(out[0].result).toBe(result);
    }
  });

  it('tool_start만 있고 매칭되는 tool_result가 없으면 result=undefined로 그룹 생성', () => {
    const start = ev('30', 'tool_start', { tool_use_id: 'tu_pending' });
    const out = groupChatEvents([start]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: 'tool',
      start,
      result: undefined,
      key: 'tool-30',
    });
  });

  it('timeline payload.type이 tool_use여도 event_type 기준 tool_start로 정규화한다', () => {
    const out = groupChatEvents([
      toSessionEvent({
        id: 31,
        parent_event_id: null,
        event_type: 'tool_start',
        payload: {
          type: 'tool_use',
          tool_use_id: 'tu_pending',
          tool_name: 'Bash',
          tool_input: { command: 'pnpm test' },
        },
        created_at: '2026-05-24T00:00:00Z',
      }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: 'tool',
      start: expect.objectContaining({
        id: '31',
        type: 'tool_start',
        data: expect.objectContaining({
          type: 'tool_use',
          tool_use_id: 'tu_pending',
        }),
      }),
      result: undefined,
      key: 'tool-31',
    });
  });

  it('매칭되지 않은 orphan tool_result는 출력에 포함되지 않는다 (F-F — invisible phantom cell 차단)', () => {
    // EventRenderer.tsx case 'tool_result' → null 분기 영향으로 zero-height invisible phantom cell이 되는
    // 데이터 정합 부채를 차단한다. tool_start가 prepend로 도착하면 forward iterate가 매칭하여 자가 회복.
    const orphan = ev('40', 'tool_result', { tool_use_id: 'tu_none', output: 'x' });
    const out = groupChatEvents([orphan]);
    expect(out).toHaveLength(0);
  });

  it('Claude Code text_start/text_delta/text_end lifecycle은 final assistant_message로 commit한다', () => {
    // server engine TextDeltaEngineEvent.to_sse는 [text_start, text_delta, text_end] 3종을
    // 발생시킨다. text_start/text_end marker는 출력하지 않고, delta chunk만 한 말풍선에 누적한다.
    const events = [
      ev('1', 'text_start', { type: 'text_start', timestamp: 1.0, parent_event_id: 10 }),
      ev('2', 'text_delta', { type: 'text_delta', timestamp: 1.1, text: 'hello', parent_event_id: 10 }),
      ev('3', 'text_delta', { type: 'text_delta', timestamp: 1.2, text: ' world', parent_event_id: 10 }),
      ev('4', 'text_end', { type: 'text_end', timestamp: 1.3, parent_event_id: 10 }),
    ];
    const out = groupChatEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('evt-2');
    expect(out[0].kind).toBe('event');
    if (out[0].kind === 'event') {
      expect(out[0].event.id).toBe('2');
      expect(out[0].event.type).toBe('assistant_message');
      expect(out[0].event.data.text).toBe('hello world');
    }
  });

  it('text_delta 단독 chunk들도 하나의 stable assistant 말풍선으로 누적한다', () => {
    const events = [
      ev('2', 'text_delta', {
        type: 'text_delta',
        timestamp: 1.1,
        text: 'hel',
        raw_event_type: 'item/agentMessage/delta',
      }),
      ev('3', 'text_end', { type: 'text_end', timestamp: 1.2, parent_event_id: 10 }),
    ];
    const first = groupChatEvents(events.slice(0, 1));
    expect(first).toHaveLength(1);
    expect(first[0].key).toBe('evt-2');

    const next = groupChatEvents([
      events[0],
      ev('4', 'text_delta', {
        type: 'text_delta',
        timestamp: 1.15,
        text: 'lo',
        raw_event_type: 'item/agentMessage/delta',
      }),
    ]);
    expect(next).toHaveLength(1);
    expect(next[0].key).toBe('evt-2');
    if (next[0].kind === 'event') {
      expect(next[0].event.data.text).toBe('hello');
    }
  });

  it('app-server chunk가 아닌 단독 text_delta들은 기존처럼 개별 이벤트로 둔다', () => {
    const events = [
      ev('2', 'text_delta', { type: 'text_delta', timestamp: 1.1, text: 'hello' }),
      ev('3', 'text_delta', { type: 'text_delta', timestamp: 1.2, text: 'world' }),
    ];
    const out = groupChatEvents(events);
    expect(out).toHaveLength(2);
    expect(out.map((item) => item.key)).toEqual(['evt-2', 'evt-3']);
  });

  it('app-server final assistant_message는 진행 중 말풍선에 흡수되어 중복 말풍선을 만들지 않는다', () => {
    const events = [
      ev('1', 'text_start', {
        type: 'text_start',
        timestamp: 1.0,
        tool_use_id: 'item-1',
        _live_only: true,
      }),
      ev('2', 'text_delta', {
        type: 'text_delta',
        timestamp: 1.1,
        text: 'Hel',
        raw_event_type: 'item/agentMessage/delta',
        tool_use_id: 'item-1',
        _live_only: true,
      }),
      ev('3', 'text_delta', {
        type: 'text_delta',
        timestamp: 1.2,
        text: 'lo',
        raw_event_type: 'item/agentMessage/delta',
        tool_use_id: 'item-1',
        _live_only: true,
      }),
      ev('4', 'assistant_message', {
        type: 'assistant_message',
        timestamp: 1.3,
        content: 'Hello final',
        raw_event_type: 'item/completed',
        tool_use_id: 'item-1',
        _final_for_live_stream: true,
      }),
      ev('5', 'text_end', {
        type: 'text_end',
        timestamp: 1.3,
        tool_use_id: 'item-1',
        _live_only: true,
      }),
    ];

    const out = groupChatEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('evt-2');
    expect(out[0].kind).toBe('event');
    if (out[0].kind === 'event') {
      expect(out[0].event.id).toBe('4');
      expect(out[0].event.type).toBe('assistant_message');
      expect(out[0].event.data.text).toBe('Hello final');
    }
  });

  it('raw durable delta와 decorated final의 item identity를 맞춰 한 행만 렌더한다', () => {
    const events = [
      ev('70', 'text_delta', {
        text: 'raw suffix',
        item_id: 'item-mixed',
        raw_event_type: 'item/agentMessage/delta',
        _live_only: true,
      }),
      ev('71', 'assistant_message', {
        content: 'complete response',
        item_id: 'item-mixed',
        _final_for_live_stream: true,
        streamIdentity: 'codex_app_server:opaque-mixed',
        liveSeq: 43,
        liveTextMode: 'append',
      }),
    ];

    const out = groupChatEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0].kind === 'event' && out[0].event.data.content)
      .toBe('complete response');
  });

  it('events에 text_start만 있고 live slot delta를 렌더 직전 합쳐도 기존 경로처럼 말풍선을 만든다', () => {
    const events = [
      ev('1', 'text_start', {
        type: 'text_start',
        timestamp: 1.0,
        item_id: 'item-1',
        _live_only: true,
      }),
    ];
    const streamingSlot = ev('live-slot', 'text_delta', {
      type: 'text_delta',
      timestamp: 1.1,
      text: 'Hello',
      raw_event_type: 'item/agentMessage/delta',
      item_id: 'item-1',
      _live_only: true,
    });

    const out = groupChatEvents([...events, streamingSlot]);

    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('evt-live-slot');
    expect(out[0].kind).toBe('event');
    if (out[0].kind === 'event') {
      expect(out[0].event.type).toBe('text_delta');
      expect(out[0].event.data.text).toBe('Hello');
    }
  });

  it('events에 text_start만 있고 cumulative live slot delta를 합쳐도 assistant 말풍선을 만든다', () => {
    const events = [
      ev('1', 'text_start', {
        type: 'text_start',
        timestamp: 1.0,
        parent_event_id: 10,
      }),
    ];
    const streamingSlot = ev('live-cumulative', 'text_delta', {
      type: 'text_delta',
      timestamp: 1.1,
      text: 'Hello cumulative',
      parent_event_id: 10,
    });

    const out = groupChatEvents([...events, streamingSlot]);

    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('evt-live-cumulative');
    expect(out[0].kind).toBe('event');
    if (out[0].kind === 'event') {
      expect(out[0].event.type).toBe('text_delta');
      expect(out[0].event.data.text).toBe('Hello cumulative');
    }
  });

  it('app-server final assistant_message가 있으면 active streaming 판정을 종료한다', () => {
    const events = [
      ev('2', 'text_delta', {
        type: 'text_delta',
        timestamp: 1.1,
        text: 'Hel',
        raw_event_type: 'item/agentMessage/delta',
        tool_use_id: 'item-1',
        _live_only: true,
      }),
      ev('3', 'assistant_message', {
        type: 'assistant_message',
        timestamp: 1.2,
        content: 'Hello final',
        raw_event_type: 'item/completed',
        tool_use_id: 'item-1',
        _final_for_live_stream: true,
      }),
    ];

    expect(hasActiveStreamingAssistantText(events)).toBe(false);
  });

  it('history의 final assistant_message는 단독 assistant 말풍선으로 유지한다', () => {
    const final = ev('4', 'assistant_message', {
      type: 'assistant_message',
      timestamp: 1.3,
      content: 'Hello final',
      raw_event_type: 'item/completed',
      tool_use_id: 'item-1',
      _final_for_live_stream: true,
    });

    const out = groupChatEvents([final]);
    expect(out).toEqual([{ kind: 'event', event: final, key: 'evt-4' }]);
  });

  it('빈 text lifecycle은 출력에서 제외한다', () => {
    const events = [
      ev('1', 'text_start', { type: 'text_start', timestamp: 1.0 }),
      ev('2', 'text_delta', { type: 'text_delta', timestamp: 1.1, text: '   ' }),
      ev('3', 'text_end', { type: 'text_end', timestamp: 1.2 }),
    ];
    const out = groupChatEvents(events);
    expect(out).toHaveLength(0);
  });

  it('orphan tool_result만 있는 첫 페이지에서 prepend로 매칭 tool_start가 도착하면 forward iterate로 매칭이 자가 회복된다 (F-F)', () => {
    // 첫 페이지: tool_result만 (tool_start는 이전 페이지에 있음)
    const firstPage = [ev('40', 'tool_result', { tool_use_id: 'tu_pair', output: 'r1' })];
    const beforePrepend = groupChatEvents(firstPage);
    expect(beforePrepend).toHaveLength(0); // F-F: 출력 제외

    // prepend 후: tool_start가 events 앞에 추가됨 (mergeSorted ASC 결과)
    const merged = [
      ev('39', 'tool_start', { tool_use_id: 'tu_pair' }),
      ev('40', 'tool_result', { tool_use_id: 'tu_pair', output: 'r1' }),
    ];
    const afterPrepend = groupChatEvents(merged);
    expect(afterPrepend).toHaveLength(1);
    expect(afterPrepend[0]).toEqual({
      kind: 'tool',
      start: merged[0],
      result: merged[1],
      key: 'tool-39',
    });
  });

  it('두 개의 tool_start 사이에 다른 이벤트가 있어도 정확히 매칭한다 (consumed 가드)', () => {
    const start1 = ev('50', 'tool_start', { tool_use_id: 'tu_x' });
    const between = ev('51', 'assistant_message', { text: '진행 중' });
    const result1 = ev('52', 'tool_result', { tool_use_id: 'tu_x' });
    const start2 = ev('53', 'tool_start', { tool_use_id: 'tu_y' });
    const result2 = ev('54', 'tool_result', { tool_use_id: 'tu_y' });
    const out = groupChatEvents([start1, between, result1, start2, result2]);
    // 결과: [tool(tu_x, result1), event(between), tool(tu_y, result2)]
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: 'tool', start: start1, result: result1, key: 'tool-50' });
    expect(out[1]).toEqual({ kind: 'event', event: between, key: 'evt-51' });
    expect(out[2]).toEqual({ kind: 'tool', start: start2, result: result2, key: 'tool-53' });
    // result1은 consumed되어 별도 항목으로 흘러나오지 않음
    expect(out.find((x) => x.kind === 'event' && x.key === 'evt-52')).toBeUndefined();
  });

  it('key 형식은 tool 그룹은 `tool-${start.id}`, 일반은 `evt-${event.id}` 이다', () => {
    const start = ev('60', 'tool_start', { tool_use_id: 'k1' });
    const result = ev('61', 'tool_result', { tool_use_id: 'k1' });
    const msg = ev('62', 'user_message', { text: 'hi' });
    const out = groupChatEvents([start, result, msg]);
    expect(out[0].key).toBe('tool-60');
    expect(out[1].key).toBe('evt-62');
  });
});

describe('streamingSlotRenderItems', () => {
  it('live streaming slots are converted without regrouping the full history', () => {
    const thinking = ev('thinking-1', 'thinking_delta', { thinking: '분석 중' });
    const assistant = ev('delta-2', 'text_delta', {
      text: 'Hello',
      item_id: 'item-a',
      raw_event_type: 'item/agentMessage/delta',
      _live_only: true,
    });

    expect(
      streamingSlotRenderItems({ thinking, assistant }).map((item) => ({
        key: item.key,
        type: item.kind === 'event' ? item.event.type : item.kind,
      })),
    ).toEqual([
      { key: 'stream-thinking', type: 'thinking_delta' },
      { key: 'stream-assistant-item-a', type: 'text_delta' },
    ]);
  });

  it('assistant streaming item key stays stable across delta event ids for the same stream', () => {
    const first = streamingSlotRenderItems({
      assistant: ev('delta-1', 'text_delta', {
        text: 'Hel',
        item_id: 'item-a',
        raw_event_type: 'item/agentMessage/delta',
        _live_only: true,
      }),
    });
    const next = streamingSlotRenderItems({
      assistant: ev('delta-2', 'text_delta', {
        text: 'Hello',
        item_id: 'item-a',
        raw_event_type: 'item/agentMessage/delta',
        _live_only: true,
      }),
    });

    expect(first[0].key).toBe('stream-assistant-item-a');
    expect(next[0].key).toBe('stream-assistant-item-a');
  });

  it('streaming item key stays stable even when only event ids change', () => {
    const first = streamingSlotRenderItems({
      assistant: ev('delta-1', 'text_delta', { text: 'Hel' }),
      thinking: ev('thinking-1', 'thinking_delta', { thinking: '분석' }),
    });
    const next = streamingSlotRenderItems({
      assistant: ev('delta-2', 'text_delta', { text: 'Hello' }),
      thinking: ev('thinking-2', 'thinking_delta', { thinking: '분석 중' }),
    });

    expect(first.map((item) => item.key)).toEqual([
      'stream-thinking',
      'stream-assistant',
    ]);
    expect(next.map((item) => item.key)).toEqual([
      'stream-thinking',
      'stream-assistant',
    ]);
  });

  it('v2 recovered assistant streams를 opaque identity별 stable row로 모두 렌더한다', () => {
    const recovered = (identity: string, text: string) => ev(
      `snapshot-${identity}`,
      'text_delta',
      { text, streamIdentity: identity, liveSeq: 41, liveTextMode: 'replace' },
    );
    const out = streamingSlotRenderItems({
      assistantByStream: {
        'opaque-a': recovered('opaque-a', 'A'),
        'opaque-b': recovered('opaque-b', 'B'),
      },
    });

    expect(out.map((item) => item.key)).toEqual([
      'stream-assistant-opaque-a',
      'stream-assistant-opaque-b',
    ]);
  });

  it('v2 SDK replace history는 cumulative text를 중복 연결하지 않는다', () => {
    const events = [
      ev('1', 'text_delta', {
        text: 'hel',
        streamIdentity: 'sdk-stream',
        liveSeq: 1,
        liveTextMode: 'replace',
      }),
      ev('2', 'text_delta', {
        text: 'hello',
        streamIdentity: 'sdk-stream',
        liveSeq: 2,
        liveTextMode: 'replace',
      }),
    ];

    const out = groupChatEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0].kind === 'event' && out[0].event.data.text).toBe('hello');
  });
});

describe('hasActiveStreamingAssistantText', () => {
  it('text_delta가 들어왔고 text_end 전이면 true', () => {
    expect(
      hasActiveStreamingAssistantText([
        ev('1', 'text_start'),
        ev('2', 'text_delta', { text: 'hello' }),
      ]),
    ).toBe(true);
  });

  it('공백뿐인 delta나 text_end 이후에는 false', () => {
    expect(
      hasActiveStreamingAssistantText([
        ev('1', 'text_start'),
        ev('2', 'text_delta', { text: '   ' }),
      ]),
    ).toBe(false);
    expect(
      hasActiveStreamingAssistantText([
        ev('1', 'text_start'),
        ev('2', 'text_delta', { text: 'hello' }),
        ev('3', 'text_end'),
      ]),
    ).toBe(false);
  });

  it('app-server delta는 text_start가 없어도 active text로 본다', () => {
    expect(
      hasActiveStreamingAssistantText([
        ev('2', 'text_delta', {
          text: 'hello',
          raw_event_type: 'item/agentMessage/delta',
        }),
      ]),
    ).toBe(true);
  });
});

describe('placePendingOptimistic', () => {
  it('전송 시점 anchor 이후, 더 나중 서버 이벤트 이전에 둔다', () => {
    const user = ev('1', 'user_message', { text: '기존' });
    const tool = ev('10', 'tool_start', { tool_use_id: 'tu_later' });
    const pending = {
      ...createOptimisticUserEvent('새 메시지', 'intervention_sent'),
      data: {
        text: '새 메시지',
        user: 'soul-app',
        __optimisticAfterEventId: '1',
      },
    };
    const out = placePendingOptimistic(groupChatEvents([user, tool]), pending);
    expect(out.map((item) => item.key)).toEqual(['evt-1', `evt-${pending.id}`, 'tool-10']);
  });

  it('anchor가 null인 새 세션 첫 prompt optimistic은 서버 이벤트 앞에 둔다', () => {
    const tool = ev('10', 'tool_start', { tool_use_id: 'tu_first' });
    const pending = {
      ...createOptimisticUserEvent('첫 메시지', 'user_message'),
      data: {
        text: '첫 메시지',
        user: 'soul-app',
        __optimisticAfterEventId: null,
      },
    };
    const out = placePendingOptimistic(groupChatEvents([tool]), pending);
    expect(out.map((item) => item.key)).toEqual([`evt-${pending.id}`, 'tool-10']);
  });
});
