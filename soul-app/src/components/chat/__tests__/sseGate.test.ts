import {
  handleSessionSseEvent,
  flushQueuedSseEvents,
  CATCHUP_REPLAY_CHUNK_SIZE,
} from '../sseGate';
import type { Session, SessionEvent } from '../../../api/types';
import { classifySessionFeed } from '../../../lib/session-feed-groups';
import { useChatStore } from '../../../store/chatStore';

const SID = 'sse-gate-session';

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
    generationRef: { current: 1 },
  };
}

function makeActions() {
  return {
    triggerAnimation: jest.fn(),
    ingestEvent: jest.fn(),
    ingestEventsBatch: jest.fn(),
    setLastEventId: jest.fn(),
    resetToSnapshot: jest.fn(),
    updateSessionStatus: jest.fn(),
  };
}

describe('handleSessionSseEvent', () => {
  test('history_sync는 게이트를 false로 전환하고 머지하지 않는다', () => {
    const refs = makeRefs(true, false);
    const actions = makeActions();

    handleSessionSseEvent(
      'history_sync',
      { is_live: true, last_event_id: 42 },
      '',
      refs,
      actions,
    );

    expect(refs.isCatchingUpRef.current).toBe(false);
    expect(refs.framePhaseRef.current).toBe('live');
    expect(actions.ingestEvent).not.toHaveBeenCalled();
    expect(actions.triggerAnimation).not.toHaveBeenCalled();
    expect(actions.setLastEventId).toHaveBeenCalledWith('42');
    expect(actions.updateSessionStatus).not.toHaveBeenCalled();
  });

  test('reset_required history_sync는 큐를 폐기하고 boundary cursor를 snapshot commit에 위임한다', () => {
    const refs = makeRefs(true, false);
    const order: string[] = [];
    refs.pendingCatchupQueueRef.current = [
      { event: { id: '41', type: 'text_delta', data: { text: 'stale' } }, eid: '41' },
    ];
    refs.pendingLiveQueueRef.current = [
      { event: { id: '42', type: 'text_delta', data: { text: 'stale-live' } }, eid: '42' },
    ];
    const actions = {
      ...makeActions(),
      resetToSnapshot: jest.fn((baselineCursor: string | null) => {
        expect(baselineCursor).toBe('250');
        order.push('reset');
        refs.historyLoadingRef.current = true;
      }),
      setLastEventId: jest.fn(() => order.push('cursor')),
    };

    handleSessionSseEvent(
      'history_sync',
      { is_live: true, last_event_id: 250, reset_required: true },
      '',
      refs,
      actions,
    );

    expect(refs.isCatchingUpRef.current).toBe(false);
    expect(refs.pendingCatchupQueueRef.current).toEqual([]);
    expect(refs.pendingLiveQueueRef.current).toEqual([]);
    expect(actions.resetToSnapshot).toHaveBeenCalledTimes(1);
    expect(actions.ingestEventsBatch).not.toHaveBeenCalled();
    expect(actions.setLastEventId).not.toHaveBeenCalledWith('250');
    expect(order).toEqual(['reset']);

    handleSessionSseEvent(
      'assistant_message',
      { content: 'after-boundary' },
      '251',
      refs,
      actions,
    );
    expect(refs.pendingLiveQueueRef.current.map((item) => item.eid)).toEqual(['251']);
    expect(actions.ingestEvent).not.toHaveBeenCalled();

    refs.historyLoadingRef.current = false;
    flushQueuedSseEvents(refs, actions);
    expect(actions.ingestEventsBatch).toHaveBeenCalledWith([
      expect.objectContaining({ id: '251' }),
    ]);
    expect(actions.setLastEventId).toHaveBeenLastCalledWith('251');
  });

  test.each([
    'complete',
    'result',
    'error',
    'user_message',
    'intervention_sent',
    'text_delta',
    'text_end',
    'thinking_delta',
    'thinking_end',
    'tool_start',
  ])('%s 이벤트는 chat tree만 갱신하고 세션 lifecycle은 바꾸지 않는다', (type) => {
    const refs = makeRefs(false, false);
    const actions = makeActions();

    handleSessionSseEvent(type, { text: 'event' }, '101', refs, actions);

    expect(actions.ingestEvent).toHaveBeenCalledTimes(1);
    expect(actions.updateSessionStatus).not.toHaveBeenCalled();
  });

  test('history loading 중 queued result도 세션 lifecycle은 바꾸지 않는다', () => {
    const refs = makeRefs(false, true);
    const actions = makeActions();

    handleSessionSseEvent('result', { output: 'done' }, '201', refs, actions);

    expect(actions.ingestEvent).not.toHaveBeenCalled();
    expect(refs.pendingLiveQueueRef.current).toHaveLength(1);
    expect(actions.updateSessionStatus).not.toHaveBeenCalled();
  });

  test('claude_runtime_* 이벤트는 state-only라 타임라인 큐에 넣지 않고 cursor만 전진한다', () => {
    const refs = makeRefs(false, false);
    const actions = makeActions();

    handleSessionSseEvent(
      'claude_runtime_mode_state',
      { mode: 'plan', active: true },
      '250',
      refs,
      actions,
    );

    expect(actions.ingestEvent).not.toHaveBeenCalled();
    expect(actions.ingestEventsBatch).not.toHaveBeenCalled();
    expect(actions.triggerAnimation).not.toHaveBeenCalled();
    expect(actions.updateSessionStatus).not.toHaveBeenCalled();
    expect(refs.pendingLiveQueueRef.current).toHaveLength(0);
    expect(refs.pendingCatchupQueueRef.current).toHaveLength(0);
    expect(actions.setLastEventId).toHaveBeenCalledWith('250');
  });

  test.each([
    [true, false],
    [false, true],
  ])('state-only 이벤트는 앞선 queue가 미커밋(catchup=%s, loading=%s)이면 cursor를 넘기지 않는다', (
    catchingUp,
    loading,
  ) => {
    const refs = makeRefs(catchingUp, loading);
    const actions = makeActions();

    handleSessionSseEvent(
      'claude_runtime_mode_state',
      { mode: 'plan', active: true },
      '250',
      refs,
      actions,
    );

    expect(actions.setLastEventId).not.toHaveBeenCalled();
    expect(refs.pendingLiveQueueRef.current).toHaveLength(0);
    expect(refs.pendingCatchupQueueRef.current).toHaveLength(0);
  });

  test('catchup 단계: 일반 이벤트는 history_sync 전까지 큐에 모으고 머지하지 않는다', () => {
    const refs = makeRefs(true, false);
    const actions = makeActions();

    handleSessionSseEvent('text_delta', { text: 'a' }, '101', refs, actions);
    handleSessionSseEvent('text_delta', { text: 'b' }, '102', refs, actions);

    expect(actions.ingestEvent).not.toHaveBeenCalled();
    expect(actions.ingestEventsBatch).not.toHaveBeenCalled();
    expect(actions.triggerAnimation).not.toHaveBeenCalled();
    expect(actions.setLastEventId).not.toHaveBeenCalledWith('102');
    expect(refs.pendingCatchupQueueRef.current.map((q) => q.event.id)).toEqual([
      '101',
      '102',
    ]);
  });

  test('completed+needs_review 세션의 과거 replay는 review 한 행을 유지한다', () => {
    const refs = makeRefs(true, false);
    let currentSession: Session = {
      agentSessionId: 'review-session',
      displayName: 'review-session',
      status: 'completed',
      reviewState: 'needs_review',
      reviewRequired: true,
      createdAt: '2026-08-11T00:00:00Z',
      updatedAt: '2026-08-11T00:00:00Z',
    };
    const actions = {
      ...makeActions(),
      updateSessionStatus: jest.fn((status: Session['status']) => {
        currentSession = { ...currentSession, status };
      }),
    };

    handleSessionSseEvent('user_message', { text: 'old prompt' }, '101', refs, actions);
    handleSessionSseEvent('text_delta', { text: 'old answer' }, '102', refs, actions);
    handleSessionSseEvent('tool_start', { name: 'old tool' }, '103', refs, actions);

    const groups = classifySessionFeed(
      [currentSession],
      { ready: false, connectedNodeIds: new Set() },
    );
    expect(currentSession.status).toBe('completed');
    expect(groups.running).toHaveLength(0);
    expect(groups.review.map((session) => session.agentSessionId)).toEqual([
      'review-session',
    ]);
    expect(groups.running.length + groups.review.length).toBe(1);
  });

  test('라이브 단계(catchup=false, loading=false): 애니메이션이 매 건 발화된다', () => {
    const refs = makeRefs(false, false);
    const actions = makeActions();

    handleSessionSseEvent('text_delta', { text: 'live' }, '200', refs, actions);

    expect(actions.triggerAnimation).toHaveBeenCalledTimes(1);
    expect(actions.ingestEvent).toHaveBeenCalledTimes(1);
    expect(actions.setLastEventId).toHaveBeenCalledWith('200');
  });

  test('REST history 로딩 중: 라이브 SSE는 큐에 적재되고 ingestEvent/setLastEventId/triggerAnimation 모두 호출되지 않는다 (F-B)', () => {
    const refs = makeRefs(false, true);
    const actions = makeActions();

    handleSessionSseEvent('text_delta', { text: 'x' }, '300', refs, actions);

    expect(actions.triggerAnimation).not.toHaveBeenCalled();
    expect(actions.ingestEvent).not.toHaveBeenCalled();
    expect(actions.setLastEventId).not.toHaveBeenCalled();
    expect(refs.pendingLiveQueueRef.current).toHaveLength(1);
    expect(refs.pendingLiveQueueRef.current[0].event.id).toBe('300');
    expect(refs.pendingLiveQueueRef.current[0].eid).toBe('300');
  });

  test('catchup → history_sync → live 시퀀스에서 catchup은 batch ingest, 애니메이션은 라이브 1건만 발화', () => {
    const refs = makeRefs(true, false);
    const actions = makeActions();

    // catchup 3건
    handleSessionSseEvent('text_delta', { t: 'c1' }, '1', refs, actions);
    handleSessionSseEvent('text_delta', { t: 'c2' }, '2', refs, actions);
    handleSessionSseEvent('text_delta', { t: 'c3' }, '3', refs, actions);
    // 마커
    handleSessionSseEvent('history_sync', { is_live: true }, '', refs, actions);
    // 라이브 1건
    handleSessionSseEvent('text_delta', { t: 'live' }, '4', refs, actions);

    expect(actions.triggerAnimation).toHaveBeenCalledTimes(1);
    expect(actions.ingestEventsBatch).toHaveBeenCalledWith([
      expect.objectContaining({ id: '1' }),
      expect.objectContaining({ id: '2' }),
      expect.objectContaining({ id: '3' }),
    ]);
    expect(actions.ingestEvent).toHaveBeenCalledTimes(1);
    expect(refs.isCatchingUpRef.current).toBe(false);
  });

  test('재연결 시뮬레이션: catchup 재진입 후 history_sync까지 다시 차단', () => {
    const refs = makeRefs(false, false);
    const actions = makeActions();

    // 라이브 동작 중 1건
    handleSessionSseEvent('text_delta', { t: 'a' }, '10', refs, actions);
    expect(actions.triggerAnimation).toHaveBeenCalledTimes(1);

    // 재연결: ChatBody의 onOpen이 ref를 true로 리셋했다고 가정
    refs.isCatchingUpRef.current = true;

    // 재연결 후 catchup 2건
    handleSessionSseEvent('text_delta', { t: 'b' }, '11', refs, actions);
    handleSessionSseEvent('text_delta', { t: 'c' }, '12', refs, actions);
    // 여전히 라이브 단계 호출 횟수 = 1
    expect(actions.triggerAnimation).toHaveBeenCalledTimes(1);
    expect(actions.ingestEvent).toHaveBeenCalledTimes(1);

    // 마커 도착
    handleSessionSseEvent('history_sync', {}, '', refs, actions);
    // 다시 라이브
    handleSessionSseEvent('text_delta', { t: 'd' }, '13', refs, actions);
    expect(actions.triggerAnimation).toHaveBeenCalledTimes(2);
    expect(actions.ingestEventsBatch).toHaveBeenCalledWith([
      expect.objectContaining({ id: '11' }),
      expect.objectContaining({ id: '12' }),
    ]);
  });

  test('eid가 없는 이벤트는 setLastEventId를 호출하지 않는다', () => {
    const refs = makeRefs(false, false);
    const actions = makeActions();

    handleSessionSseEvent('system', { msg: 'hello' }, '', refs, actions);

    expect(actions.ingestEvent).toHaveBeenCalledTimes(1);
    expect(actions.setLastEventId).not.toHaveBeenCalled();
  });

  test('live-only 이벤트는 carried SSE cursor 대신 payload 안정 id로 머지한다', () => {
    const refs = makeRefs(false, false);
    const actions = makeActions();

    handleSessionSseEvent(
      'text_delta',
      {
        text: 'live',
        raw_event_type: 'item/agentMessage/delta',
        item_id: 'item-a',
        _live_only: true,
      },
      '500',
      refs,
      actions,
    );

    expect(actions.ingestEvent).toHaveBeenCalledTimes(1);
    const event = actions.ingestEvent.mock.calls[0][0] as SessionEvent;
    expect(event.id).toMatch(
      /^live:text_delta:item\/agentMessage\/delta:item-a:text:[a-z0-9]+$/,
    );
    expect(event.id).not.toBe('500');
    expect(actions.setLastEventId).not.toHaveBeenCalled();
  });

  test('같은 live-only payload의 replay는 payload 안정 id로 dedup한다', () => {
    const refs = makeRefs(false, false);
    useChatStore.getState().clearSession(SID);
    const actions = {
      ...makeActions(),
      ingestEvent: (event: SessionEvent) =>
        useChatStore.getState().mergeEvents(SID, [event]),
    };
    const payload = {
      text: 'repeat',
      raw_event_type: 'item/agentMessage/delta',
      item_id: 'item-repeat',
      _live_only: true,
    };

    handleSessionSseEvent('text_delta', payload, '500', refs, actions);
    handleSessionSseEvent('text_delta', payload, '500', refs, actions);

    const stored = useChatStore.getState().eventsBySession[SID] ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0].data.text).toBe('repeat');
  });

  test('같은 carried SSE cursor와 본문이어도 서로 다른 liveSeq는 보존한다', () => {
    const refs = makeRefs(false, false);
    useChatStore.getState().clearSession(SID);
    const actions = {
      ...makeActions(),
      ingestEvent: (event: SessionEvent) =>
        useChatStore.getState().mergeEvents(SID, [event]),
    };
    const payload = {
      text: 'repeat',
      raw_event_type: 'item/agentMessage/delta',
      item_id: 'item-repeat',
      streamIdentity: 'codex_app_server:item-repeat',
      liveTextMode: 'append',
      _live_only: true,
    };

    handleSessionSseEvent(
      'text_delta',
      { ...payload, liveSeq: 41 },
      '500',
      refs,
      actions,
    );
    handleSessionSseEvent(
      'text_delta',
      { ...payload, liveSeq: 42 },
      '500',
      refs,
      actions,
    );
    handleSessionSseEvent(
      'text_delta',
      { ...payload, liveSeq: 42 },
      '500',
      refs,
      actions,
    );

    const stored = useChatStore.getState().eventsBySession[SID] ?? [];
    expect(stored).toHaveLength(2);
    expect(stored.map((event) => event.id)).toEqual([
      'live:text_delta:item/agentMessage/delta:codex_app_server:item-repeat:index:41',
      'live:text_delta:item/agentMessage/delta:codex_app_server:item-repeat:index:42',
    ]);
  });

  test('legacy 동일 본문은 timestamp로 실제 chunk를 구분하고 동일 payload 재수신은 dedupe한다', () => {
    const refs = makeRefs(false, false);
    useChatStore.getState().clearSession(SID);
    const actions = {
      ...makeActions(),
      ingestEvent: (event: SessionEvent) =>
        useChatStore.getState().mergeEvents(SID, [event]),
    };
    const payload = {
      text: 'x',
      raw_event_type: 'item/agentMessage/delta',
      tool_use_id: 'item-legacy-repeat',
      _live_only: true,
    };

    handleSessionSseEvent(
      'text_delta',
      { ...payload, timestamp: 100.001 },
      '500',
      refs,
      actions,
    );
    handleSessionSseEvent(
      'text_delta',
      { ...payload, timestamp: 100.002 },
      '500',
      refs,
      actions,
    );
    handleSessionSseEvent(
      'text_delta',
      { ...payload, timestamp: 100.002 },
      '500',
      refs,
      actions,
    );

    const stored = useChatStore.getState().eventsBySession[SID] ?? [];
    expect(stored).toHaveLength(2);
    expect(stored.map((event) => event.id)).toEqual([
      expect.stringContaining('timestamp:100.001:'),
      expect.stringContaining('timestamp:100.002:'),
    ]);
  });

  test('durable replay의 명시 SSE id는 동일 payload에서도 각각 보존한다', () => {
    const refs = makeRefs(true, false);
    useChatStore.getState().clearSession(SID);
    const actions = {
      ...makeActions(),
      ingestEvent: (event: SessionEvent) =>
        useChatStore.getState().mergeEvents(SID, [event]),
    };
    const payload = {
      text: 'x',
      raw_event_type: 'item/agentMessage/delta',
      tool_use_id: 'item-durable',
      _live_only: true,
    };

    handleSessionSseEvent('text_delta', payload, '50', refs, actions);
    handleSessionSseEvent('text_delta', payload, '51', refs, actions);

    expect(refs.pendingCatchupQueueRef.current.map(({ event }) => event.id))
      .toEqual(['50', '51']);
  });

  test('live committed payload의 _event_id는 carried SSE cursor보다 우선한다', () => {
    const refs = makeRefs(false, false);
    const actions = makeActions();

    handleSessionSseEvent(
      'text_delta',
      {
        _event_id: 501,
        id: 501,
        text: 'current-live',
        raw_event_type: 'item/agentMessage/delta',
        item_id: 'item-current',
        streamIdentity: 'codex_app_server:item-current',
        liveSeq: 43,
        liveTextMode: 'append',
        _live_only: true,
      },
      '500',
      refs,
      actions,
    );

    const event = actions.ingestEvent.mock.calls[0][0] as SessionEvent;
    expect(event.id).toBe('501');
    expect(actions.setLastEventId).not.toHaveBeenCalled();
  });

  test('id 없는 durable 재방출은 carried cursor보다 payload event id를 store에 우선한다', () => {
    const refs = makeRefs(false, false);
    const actions = makeActions();

    handleSessionSseEvent(
      'assistant_message',
      {
        _event_id: 79,
        type: 'assistant_message',
        content: 'durable final',
        item_id: 'item-final',
        _final_for_live_stream: true,
        streamIdentity: 'codex_sdk:aXRlbS1maW5hbA',
        liveSeq: 52,
        liveTextMode: 'replace',
      },
      '80',
      refs,
      actions,
    );

    const event = actions.ingestEvent.mock.calls[0][0] as SessionEvent;
    expect(event.id).toBe('79');
    expect(actions.setLastEventId).toHaveBeenCalledWith('80');
  });

  test('history_sync last_event_id가 없거나 0이면 lastEventId를 갱신하지 않는다', () => {
    const refs = makeRefs(true, false);
    const actions = makeActions();

    handleSessionSseEvent(
      'history_sync',
      { is_live: true, last_event_id: 0 },
      '',
      refs,
      actions,
    );

    expect(refs.isCatchingUpRef.current).toBe(false);
    expect(actions.setLastEventId).not.toHaveBeenCalled();
  });

  test('catchup replay N건은 history_sync 도착 후 chunked batch로 들어가고 LayoutAnimation을 발화하지 않는다', () => {
    jest.useFakeTimers();
    const refs = makeRefs(true, false);
    const actions = makeActions();

    for (let i = 1; i <= 60; i += 1) {
      handleSessionSseEvent('text_delta', { text: `chunk-${i}` }, String(i), refs, actions);
    }

    expect(actions.ingestEvent).not.toHaveBeenCalled();
    expect(actions.ingestEventsBatch).not.toHaveBeenCalled();
    expect(refs.pendingCatchupQueueRef.current).toHaveLength(60);

    handleSessionSseEvent(
      'history_sync',
      { is_live: true, last_event_id: 100 },
      '',
      refs,
      actions,
    );

    expect(refs.pendingCatchupQueueRef.current).toHaveLength(10);
    expect(actions.ingestEventsBatch).toHaveBeenCalledTimes(1);
    expect(actions.ingestEventsBatch.mock.calls[0][0].length).toBeLessThan(60);
    expect(actions.triggerAnimation).not.toHaveBeenCalled();
    expect(actions.setLastEventId).not.toHaveBeenCalledWith('100');

    jest.runOnlyPendingTimers();

    const totalIngested = actions.ingestEventsBatch.mock.calls.reduce(
      (sum, call) => sum + (call[0] as SessionEvent[]).length,
      0,
    );
    expect(totalIngested).toBe(60);
    expect(actions.setLastEventId).toHaveBeenCalledWith('100');
    expect(actions.setLastEventId).toHaveBeenLastCalledWith('100');
    expect(actions.triggerAnimation).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('history_sync 뒤 wire live는 catchup drain 중이어도 carried replay cursor를 id로 쓰지 않는다', () => {
    jest.useFakeTimers();
    const refs = makeRefs(true, false);
    const actions = makeActions();

    for (let i = 1; i <= 51; i += 1) {
      handleSessionSseEvent('system', { message: `replay-${i}` }, String(i), refs, actions);
    }
    handleSessionSseEvent(
      'history_sync',
      { is_live: true, last_event_id: 1003 },
      '',
      refs,
      actions,
    );

    expect(refs.isCatchingUpRef.current).toBe(true);
    expect(refs.framePhaseRef.current).toBe('live');

    handleSessionSseEvent(
      'text_delta',
      {
        text: '+live',
        raw_event_type: 'item/agentMessage/delta',
        streamIdentity: 'codex_app_server:item-after-marker',
        liveSeq: 42,
        _live_only: true,
      },
      '1003',
      refs,
      actions,
    );

    expect(refs.pendingCatchupQueueRef.current.map(({ event }) => event.id))
      .toEqual([
        '51',
        'live:text_delta:item/agentMessage/delta:codex_app_server:item-after-marker:index:42',
      ]);

    jest.runOnlyPendingTimers();
    expect(actions.setLastEventId).toHaveBeenLastCalledWith('1003');
    jest.useRealTimers();
  });

  test('history_sync baseline cursor는 catchup chunk cursor보다 뒤로 밀리지 않는다', () => {
    jest.useFakeTimers();
    useChatStore.getState().clearSession(SID);
    const refs = makeRefs(true, false);
    const actions = {
      ...makeActions(),
      ingestEventsBatch: (events: SessionEvent[]) =>
        useChatStore.getState().mergeEvents(SID, events),
      setLastEventId: (id: string) =>
        useChatStore.getState().setLastEventId(SID, id),
    };

    for (let i = 1; i <= 60; i += 1) {
      handleSessionSseEvent('text_delta', { text: `chunk-${i}` }, String(i), refs, actions);
    }
    handleSessionSseEvent(
      'history_sync',
      { is_live: true, last_event_id: 100 },
      '',
      refs,
      actions,
    );
    jest.runOnlyPendingTimers();

    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('100');
    expect(useChatStore.getState().eventsBySession[SID]).toHaveLength(60);
    jest.useRealTimers();
  });

  test('catchup chunk timer는 generation이 바뀌면 남은 chunk를 버린다', () => {
    jest.useFakeTimers();
    const refs = makeRefs(true, false);
    const actions = makeActions();

    for (let i = 1; i <= 60; i += 1) {
      handleSessionSseEvent('text_delta', { text: `chunk-${i}` }, String(i), refs, actions);
    }

    handleSessionSseEvent(
      'history_sync',
      { is_live: true, last_event_id: 100 },
      '',
      refs,
      actions,
    );
    expect(actions.ingestEventsBatch).toHaveBeenCalledTimes(1);
    refs.generationRef.current += 1;

    jest.runOnlyPendingTimers();

    const totalIngested = actions.ingestEventsBatch.mock.calls.reduce(
      (sum, call) => sum + (call[0] as SessionEvent[]).length,
      0,
    );
    expect(totalIngested).toBe(CATCHUP_REPLAY_CHUNK_SIZE);
    expect(actions.setLastEventId).toHaveBeenLastCalledWith(
      String(CATCHUP_REPLAY_CHUNK_SIZE),
    );
    expect(actions.setLastEventId).not.toHaveBeenCalledWith('100');
    jest.useRealTimers();
  });

  test('history_sync 직후 비활성 전환은 미커밋 chunk를 넘는 baseline cursor로 점프하지 않는다', () => {
    jest.useFakeTimers();
    const refs = makeRefs(true, false);
    const actions = makeActions();

    for (let i = 1; i <= 60; i += 1) {
      handleSessionSseEvent('text_delta', { text: `chunk-${i}` }, String(i), refs, actions);
    }
    handleSessionSseEvent(
      'history_sync',
      { is_live: true, last_event_id: 100 },
      '',
      refs,
      actions,
    );
    expect(actions.ingestEventsBatch).toHaveBeenCalledTimes(1);

    // background/hidden cleanup과 같은 generation 전환. 남은 51..60은 reconnect replay 대상이다.
    refs.generationRef.current += 1;
    refs.pendingCatchupQueueRef.current = [];
    jest.runOnlyPendingTimers();

    expect(actions.setLastEventId).toHaveBeenLastCalledWith('50');
    expect(actions.setLastEventId).not.toHaveBeenCalledWith('100');
    jest.useRealTimers();
  });
});
