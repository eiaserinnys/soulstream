import {
  STREAMING_DELTA_FLUSH_MS,
  cancelStreamingDeltaBuffer,
  createStreamingDeltaBuffer,
  dispatchStreamingDelta,
  enqueueStreamingDelta,
  flushStreamingDeltaBuffer,
  streamingDeltaKind,
  streamingSlotTransitionForEvent,
} from '../streamingDeltaBuffer';
import type { SessionEvent } from '../../../api/types';

const ev = (
  id: string,
  type: SessionEvent['type'],
  data: Record<string, unknown> = {},
): SessionEvent => ({ id, type, data });

const liveAppDelta = (id: string, itemId: string, text: string): SessionEvent =>
  ev(id, 'text_delta', {
    text,
    item_id: itemId,
    raw_event_type: 'item/agentMessage/delta',
    _live_only: true,
  });

function makeActions() {
  return {
    commitStreamingEvent: jest.fn(),
    setLastEventId: jest.fn(),
  };
}

describe('streamingDeltaKind', () => {
  it('text_delta는 assistant slot, thinking_delta는 thinking slot으로 분류한다', () => {
    expect(streamingDeltaKind('text_delta')).toBe('assistant');
    expect(streamingDeltaKind('thinking_delta')).toBe('thinking');
    expect(streamingDeltaKind('tool_start')).toBeNull();
  });
});

describe('streamingDeltaBuffer — 50ms coalesce', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('50ms 전에는 commit하지 않고 같은 slot의 최신 delta 1건만 commit한다', () => {
    const buffer = createStreamingDeltaBuffer();
    const actions = makeActions();

    enqueueStreamingDelta(
      buffer,
      { kind: 'assistant', event: ev('10', 'text_delta', { text: 'Hel' }), eid: '10' },
      actions,
    );
    enqueueStreamingDelta(
      buffer,
      { kind: 'assistant', event: ev('11', 'text_delta', { text: 'Hello' }), eid: '11' },
      actions,
    );

    jest.advanceTimersByTime(STREAMING_DELTA_FLUSH_MS - 1);
    expect(actions.commitStreamingEvent).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(actions.commitStreamingEvent).toHaveBeenCalledTimes(1);
    expect(actions.commitStreamingEvent).toHaveBeenCalledWith(
      'assistant',
      ev('11', 'text_delta', { text: 'Hello' }),
    );
    expect(actions.setLastEventId).toHaveBeenCalledWith('11');
  });

  it('timer commit throw는 buffer와 cursor를 보존하고 비동기 재연결을 요청한다', () => {
    const buffer = createStreamingDeltaBuffer();
    const error = new Error('thinking store commit failed');
    const actions = {
      ...makeActions(),
      onAsyncCommitError: jest.fn(),
    };
    actions.commitStreamingEvent.mockImplementationOnce(() => { throw error; });
    enqueueStreamingDelta(
      buffer,
      {
        kind: 'thinking',
        event: ev('12', 'thinking_delta', { thinking: 'must replay' }),
        eid: '12',
      },
      actions,
    );

    jest.advanceTimersByTime(STREAMING_DELTA_FLUSH_MS);

    expect(actions.onAsyncCommitError).toHaveBeenCalledWith(error);
    expect(buffer.pendingByKind.thinking?.eid).toBe('12');
    expect(buffer.order).toEqual(['thinking']);
    expect(actions.setLastEventId).not.toHaveBeenCalled();
  });

  it('live-only app-server chunk는 50ms buffer 안에서 누적해 commit한다', () => {
    const buffer = createStreamingDeltaBuffer();
    const actions = makeActions();

    enqueueStreamingDelta(
      buffer,
      { kind: 'assistant', event: liveAppDelta('a', 'item-a', 'Hel'), eid: '' },
      actions,
    );
    enqueueStreamingDelta(
      buffer,
      { kind: 'assistant', event: liveAppDelta('b', 'item-a', 'lo'), eid: '' },
      actions,
    );

    jest.advanceTimersByTime(STREAMING_DELTA_FLUSH_MS);

    expect(actions.commitStreamingEvent).toHaveBeenCalledWith(
      'assistant',
      liveAppDelta('b', 'item-a', 'Hello'),
    );
  });

  it('구조 이벤트 직전 flush는 pending timer를 취소하고 즉시 commit한다', () => {
    const buffer = createStreamingDeltaBuffer();
    const actions = makeActions();

    enqueueStreamingDelta(
      buffer,
      { kind: 'thinking', event: ev('20', 'thinking_delta', { thinking: '분석' }), eid: '20' },
      actions,
    );
    flushStreamingDeltaBuffer(buffer, actions);

    expect(actions.commitStreamingEvent).toHaveBeenCalledWith(
      'thinking',
      ev('20', 'thinking_delta', { thinking: '분석' }),
    );
    expect(actions.setLastEventId).toHaveBeenCalledWith('20');

    jest.advanceTimersByTime(STREAMING_DELTA_FLUSH_MS);
    expect(actions.commitStreamingEvent).toHaveBeenCalledTimes(1);
  });

  it('서로 다른 slot이 번갈아 들어와도 lastEventId는 마지막 도착 delta를 사용한다', () => {
    const buffer = createStreamingDeltaBuffer();
    const actions = makeActions();

    enqueueStreamingDelta(
      buffer,
      { kind: 'assistant', event: ev('100', 'text_delta', { text: 'a' }), eid: '100' },
      actions,
    );
    enqueueStreamingDelta(
      buffer,
      { kind: 'thinking', event: ev('101', 'thinking_delta', { thinking: 't' }), eid: '101' },
      actions,
    );
    enqueueStreamingDelta(
      buffer,
      { kind: 'assistant', event: ev('102', 'text_delta', { text: 'ab' }), eid: '102' },
      actions,
    );

    flushStreamingDeltaBuffer(buffer, actions);

    expect(actions.commitStreamingEvent).toHaveBeenCalledTimes(2);
    expect(actions.setLastEventId).toHaveBeenCalledWith('102');
  });

  it('cancel은 timer와 pending delta를 버리고 commit하지 않는다', () => {
    const buffer = createStreamingDeltaBuffer();
    const actions = makeActions();

    enqueueStreamingDelta(
      buffer,
      { kind: 'assistant', event: ev('30', 'text_delta', { text: 'drop' }), eid: '30' },
      actions,
    );
    cancelStreamingDeltaBuffer(buffer);
    jest.advanceTimersByTime(STREAMING_DELTA_FLUSH_MS);

    expect(actions.commitStreamingEvent).not.toHaveBeenCalled();
    expect(actions.setLastEventId).not.toHaveBeenCalled();
  });
});

describe('dispatchStreamingDelta', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('assistant text_delta는 timer를 기다리지 않고 즉시 commit한다', () => {
    const buffer = createStreamingDeltaBuffer();
    const actions = makeActions();

    dispatchStreamingDelta(
      buffer,
      { kind: 'assistant', event: ev('40', 'text_delta', { text: 'now' }), eid: '40' },
      actions,
    );

    expect(actions.commitStreamingEvent).toHaveBeenCalledTimes(1);
    expect(actions.commitStreamingEvent).toHaveBeenCalledWith(
      'assistant',
      ev('40', 'text_delta', { text: 'now' }),
    );
    expect(actions.setLastEventId).toHaveBeenCalledWith('40');

    jest.advanceTimersByTime(STREAMING_DELTA_FLUSH_MS);
    expect(actions.commitStreamingEvent).toHaveBeenCalledTimes(1);
  });

  it('assistant live-only chunk는 store merge가 누적할 수 있도록 즉시 commit한다', () => {
    const buffer = createStreamingDeltaBuffer();
    const actions = makeActions();

    dispatchStreamingDelta(
      buffer,
      { kind: 'assistant', event: liveAppDelta('a', 'item-a', 'Hel'), eid: '' },
      actions,
    );
    dispatchStreamingDelta(
      buffer,
      { kind: 'assistant', event: liveAppDelta('b', 'item-a', 'lo'), eid: '' },
      actions,
    );

    expect(actions.commitStreamingEvent).toHaveBeenNthCalledWith(
      1,
      'assistant',
      liveAppDelta('a', 'item-a', 'Hel'),
    );
    expect(actions.commitStreamingEvent).toHaveBeenNthCalledWith(
      2,
      'assistant',
      liveAppDelta('b', 'item-a', 'lo'),
    );
    expect(actions.setLastEventId).not.toHaveBeenCalled();
  });

  it('thinking_delta는 기존처럼 50ms buffer를 사용한다', () => {
    const buffer = createStreamingDeltaBuffer();
    const actions = makeActions();

    dispatchStreamingDelta(
      buffer,
      { kind: 'thinking', event: ev('50', 'thinking_delta', { thinking: '분석' }), eid: '50' },
      actions,
    );

    jest.advanceTimersByTime(STREAMING_DELTA_FLUSH_MS - 1);
    expect(actions.commitStreamingEvent).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(actions.commitStreamingEvent).toHaveBeenCalledWith(
      'thinking',
      ev('50', 'thinking_delta', { thinking: '분석' }),
    );
  });

  it('pending thinking_delta가 있으면 assistant 즉시 commit 전에 먼저 flush한다', () => {
    const buffer = createStreamingDeltaBuffer();
    const actions = makeActions();

    dispatchStreamingDelta(
      buffer,
      {
        kind: 'thinking',
        event: ev('60', 'thinking_delta', { thinking: '분석' }),
        eid: '60',
      },
      actions,
    );
    dispatchStreamingDelta(
      buffer,
      { kind: 'assistant', event: ev('61', 'text_delta', { text: '답' }), eid: '61' },
      actions,
    );

    expect(actions.commitStreamingEvent).toHaveBeenNthCalledWith(
      1,
      'thinking',
      ev('60', 'thinking_delta', { thinking: '분석' }),
    );
    expect(actions.commitStreamingEvent).toHaveBeenNthCalledWith(
      2,
      'assistant',
      ev('61', 'text_delta', { text: '답' }),
    );
    expect(actions.setLastEventId).toHaveBeenNthCalledWith(1, '60');
    expect(actions.setLastEventId).toHaveBeenNthCalledWith(2, '61');

    jest.advanceTimersByTime(STREAMING_DELTA_FLUSH_MS);
    expect(actions.commitStreamingEvent).toHaveBeenCalledTimes(2);
  });
});

describe('streamingSlotTransitionForEvent', () => {
  it('assistant_message는 assistant slot clear를 mergeEvents의 원자 처리에 맡긴다', () => {
    expect(streamingSlotTransitionForEvent('assistant_message', {})).toEqual({
      finalize: ['thinking'],
      clear: [],
    });
  });

  it('tool/input/complete 같은 구조 이벤트는 pending slot을 먼저 finalize한다', () => {
    expect(streamingSlotTransitionForEvent('tool_start', {})).toEqual({
      finalize: ['assistant', 'thinking'],
      clear: [],
    });
    expect(streamingSlotTransitionForEvent('input_request', {})).toEqual({
      finalize: ['assistant', 'thinking'],
      clear: [],
    });
    expect(streamingSlotTransitionForEvent('complete', {})).toEqual({
      finalize: ['assistant', 'thinking'],
      clear: [],
    });
  });
});
