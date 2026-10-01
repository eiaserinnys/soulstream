import type { SessionEvent } from '../../../api/types';
import {
  flushQueuedCatchupReplayEvents,
  flushQueuedSseEvents,
  handleSessionSseEvent,
  shouldAcceptSessionSsePayload,
} from '../sseGate';

function makeRefs(catchingUp: boolean, loading: boolean) {
  return {
    framePhaseRef: {
      current: catchingUp ? 'replay' as const : 'live' as const,
    },
    isCatchingUpRef: { current: catchingUp },
    historyLoadingRef: { current: loading },
    pendingLiveQueueRef: {
      current: [] as Array<{ event: SessionEvent; eid: string }>,
    },
    pendingCatchupQueueRef: {
      current: [] as Array<{ event: SessionEvent; eid: string }>,
    },
  };
}

function makeActions() {
  return {
    triggerAnimation: jest.fn(),
    ingestEvent: jest.fn(),
    ingestEventsBatch: jest.fn(),
    setLastEventId: jest.fn(),
  };
}

describe('shouldAcceptSessionSsePayload', () => {
  test('payload에 세션 식별자가 없으면 기존 호환을 위해 통과시킨다', () => {
    expect(shouldAcceptSessionSsePayload('sess-a', { text: 'hello' })).toBe(true);
  });

  test('agentSessionId/session_id가 현재 세션과 일치하면 통과한다', () => {
    expect(shouldAcceptSessionSsePayload('sess-a', { agentSessionId: 'sess-a' })).toBe(true);
    expect(shouldAcceptSessionSsePayload('sess-a', { session_id: 'sess-a' })).toBe(true);
  });

  test('agentSessionId/session_id가 현재 세션과 다르면 drop한다', () => {
    expect(shouldAcceptSessionSsePayload('sess-a', { agentSessionId: 'sess-b' })).toBe(false);
    expect(shouldAcceptSessionSsePayload('sess-a', { session_id: 'sess-b' })).toBe(false);
    expect(
      shouldAcceptSessionSsePayload('sess-a', {
        agentSessionId: 'sess-a',
        session_id: 'sess-b',
      }),
    ).toBe(false);
  });
});

describe('flushQueuedSseEvents (F-B)', () => {
  test('큐가 비어 있으면 no-op', () => {
    const refs = makeRefs(false, false);
    const actions = makeActions();
    flushQueuedSseEvents(refs, actions);
    expect(actions.ingestEventsBatch).not.toHaveBeenCalled();
    expect(actions.triggerAnimation).not.toHaveBeenCalled();
    expect(actions.setLastEventId).not.toHaveBeenCalled();
  });

  test('큐 N건은 한 번의 ingestEventsBatch + 마지막 eid setLastEventId로 처리하고 LayoutAnimation을 발화하지 않는다', () => {
    const refs = makeRefs(false, true);
    const actions = makeActions();
    handleSessionSseEvent('text_delta', { t: 'a' }, '10', refs, actions);
    handleSessionSseEvent('text_delta', { t: 'b' }, '11', refs, actions);
    handleSessionSseEvent('text_delta', { t: 'c' }, '12', refs, actions);
    expect(refs.pendingLiveQueueRef.current).toHaveLength(3);

    refs.historyLoadingRef.current = false;
    flushQueuedSseEvents(refs, actions);

    expect(actions.ingestEventsBatch).toHaveBeenCalledTimes(1);
    const passed = actions.ingestEventsBatch.mock.calls[0][0] as SessionEvent[];
    expect(passed.map((event) => event.id)).toEqual(['10', '11', '12']);
    expect(actions.setLastEventId).toHaveBeenLastCalledWith('12');
    expect(actions.triggerAnimation).not.toHaveBeenCalled();
    expect(refs.pendingLiveQueueRef.current).toHaveLength(0);
  });

  test('batch commit throw면 queue와 cursor를 보존하고 다음 성공 flush에서 함께 commit한다', () => {
    const refs = makeRefs(false, true);
    const actions = makeActions();
    handleSessionSseEvent('system', { message: 'must replay' }, '10', refs, actions);
    refs.historyLoadingRef.current = false;
    actions.ingestEventsBatch.mockImplementationOnce(() => {
      throw new Error('batch failed');
    });

    expect(() => flushQueuedSseEvents(refs, actions)).toThrow('batch failed');
    expect(refs.pendingLiveQueueRef.current.map((item) => item.eid)).toEqual(['10']);
    expect(actions.setLastEventId).not.toHaveBeenCalled();

    handleSessionSseEvent('system', { message: 'next' }, '11', refs, actions);
    expect(actions.ingestEventsBatch).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: '10' }),
      expect.objectContaining({ id: '11' }),
    ]);
    expect(refs.pendingLiveQueueRef.current).toHaveLength(0);
    expect(actions.setLastEventId).toHaveBeenLastCalledWith('11');
  });

  test('catchup chunk commit throw면 chunk와 cursor를 제거하지 않는다', () => {
    const refs = makeRefs(true, false);
    const actions = makeActions();
    handleSessionSseEvent('system', { message: 'must replay' }, '20', refs, actions);
    actions.ingestEventsBatch.mockImplementationOnce(() => {
      throw new Error('catchup failed');
    });

    expect(() => flushQueuedCatchupReplayEvents(refs, actions, '30'))
      .toThrow('catchup failed');
    expect(refs.pendingCatchupQueueRef.current.map((item) => item.eid))
      .toEqual(['20']);
    expect(refs.isCatchingUpRef.current).toBe(true);
    expect(actions.setLastEventId).not.toHaveBeenCalled();
  });

  test('두 번째 catchup chunk commit throw는 queue를 보존하고 비동기 재연결을 요청한다', () => {
    jest.useFakeTimers();
    try {
      const refs = makeRefs(true, false);
      const actions = {
        ...makeActions(),
        onAsyncCommitError: jest.fn(),
      };
      for (let id = 1; id <= 51; id += 1) {
        handleSessionSseEvent('system', { message: `replay-${id}` }, String(id), refs, actions);
      }
      const error = new Error('second catchup chunk failed');
      actions.ingestEventsBatch.mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw error; });

      flushQueuedCatchupReplayEvents(refs, actions, '60');
      expect(refs.pendingCatchupQueueRef.current.map((item) => item.eid))
        .toEqual(['51']);
      expect(actions.setLastEventId).toHaveBeenLastCalledWith('50');

      jest.runOnlyPendingTimers();
      expect(actions.onAsyncCommitError).toHaveBeenCalledWith(error);
      expect(refs.pendingCatchupQueueRef.current.map((item) => item.eid))
        .toEqual(['51']);
      expect(refs.isCatchingUpRef.current).toBe(true);
      expect(actions.setLastEventId).toHaveBeenLastCalledWith('50');
    } finally {
      jest.useRealTimers();
    }
  });

  test('catchup 이벤트는 catchup queue로 들어가고 history_sync에서 animation 없이 flush된다', () => {
    const refs = makeRefs(true, true);
    const actions = makeActions();
    handleSessionSseEvent('text_delta', { t: 'a' }, '20', refs, actions);
    expect(refs.pendingLiveQueueRef.current).toHaveLength(0);
    expect(refs.pendingCatchupQueueRef.current).toHaveLength(1);
    refs.historyLoadingRef.current = false;
    handleSessionSseEvent('history_sync', { is_live: true }, '', refs, actions);
    expect(actions.ingestEventsBatch).toHaveBeenCalledTimes(1);
    expect(actions.triggerAnimation).not.toHaveBeenCalled();
    expect(actions.setLastEventId).toHaveBeenCalledWith('20');
  });

  test('eid 없는 큐 항목만 있으면 setLastEventId를 호출하지 않는다', () => {
    const refs = makeRefs(false, true);
    const actions = makeActions();
    handleSessionSseEvent('system', { msg: 'm1' }, '', refs, actions);
    expect(refs.pendingLiveQueueRef.current).toHaveLength(1);
    refs.historyLoadingRef.current = false;
    flushQueuedSseEvents(refs, actions);
    expect(actions.ingestEventsBatch).toHaveBeenCalledTimes(1);
    expect(actions.setLastEventId).not.toHaveBeenCalled();
  });

  test('큐 마지막이 live-only여도 마지막 persisted eid를 lastEventId로 기록한다', () => {
    const refs = makeRefs(false, true);
    const actions = makeActions();
    handleSessionSseEvent(
      'assistant_message',
      {
        content: 'final',
        item_id: 'item-a',
        _final_for_live_stream: true,
      },
      '30',
      refs,
      actions,
    );
    handleSessionSseEvent(
      'text_end',
      { item_id: 'item-a', _live_only: true },
      '30',
      refs,
      actions,
    );
    refs.historyLoadingRef.current = false;
    flushQueuedSseEvents(refs, actions);
    expect(actions.ingestEventsBatch).toHaveBeenCalledTimes(1);
    expect(actions.setLastEventId).toHaveBeenCalledWith('30');
  });
});
