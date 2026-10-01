import {
  createOptimisticUserEvent,
  getOptimisticAfterEventId,
  pickOptimisticVariant,
  useChatStore,
} from '../chatStore';
import { applyClaudeRuntimePayload } from '../claudeRuntimeProjection';
import type { SessionEvent, SessionEventType } from '../../api/types';

const SID = 'sess-test';

function evt(id: string, type: SessionEventType = 'text_delta'): SessionEvent {
  return { id, type, data: {} };
}

function liveAppDelta(id: string, itemId: string, text: string): SessionEvent {
  return {
    id,
    type: 'text_delta',
    data: {
      text,
      item_id: itemId,
      raw_event_type: 'item/agentMessage/delta',
      _live_only: true,
    },
  };
}

function reset() {
  useChatStore.getState().clearSession(SID);
}

function getEvents() {
  return useChatStore.getState().eventsBySession[SID] ?? [];
}

function getSlot() {
  return useChatStore.getState().pendingOptimisticBySession[SID];
}

function getStreamingSlots() {
  return useChatStore.getState().streamingSlotsBySession[SID];
}

describe('claudeRuntimeProjection', () => {
  it('runtime task payload를 store 없이 immutable하게 누적한다', () => {
    const created = applyClaudeRuntimePayload(undefined, 'claude_runtime_task_created', {
      task_id: 'task-1',
      description: 'Inspect the queue',
      timestamp: 10,
    });
    const updated = applyClaudeRuntimePayload(created, 'claude_runtime_task_updated', {
      task_id: 'task-1',
      patch: { status: 'running', summary: 'Working' },
      timestamp: 11,
    });

    expect(created?.tasks['task-1']).toMatchObject({
      status: 'pending',
      description: 'Inspect the queue',
    });
    expect(updated?.tasks['task-1']).toMatchObject({
      status: 'running',
      summary: 'Working',
      updatedAt: 11_000,
    });
    expect(updated?.tasks).not.toBe(created?.tasks);
  });
});

describe('chatStore.mergeEvents', () => {
  beforeEach(() => reset());

  it('빈 store에 ASC 정렬된 이벤트를 머지하면 그대로 보존된다', () => {
    const { mergeEvents } = useChatStore.getState();
    mergeEvents(SID, [evt('1'), evt('50'), evt('100')]);
    expect(getEvents().map((e) => e.id)).toEqual(['1', '50', '100']);
  });

  it('중간 id 묶음을 머지하면 정렬된 위치에 끼워 넣는다', () => {
    const { mergeEvents } = useChatStore.getState();
    mergeEvents(SID, [evt('1'), evt('50'), evt('100')]);
    mergeEvents(SID, [evt('2'), evt('49')]);
    expect(getEvents().map((e) => e.id)).toEqual(['1', '2', '49', '50', '100']);
  });

  it('이미 존재하는 id는 dedup된다 (reference 동일)', () => {
    const { mergeEvents } = useChatStore.getState();
    mergeEvents(SID, [evt('1'), evt('50'), evt('100')]);
    const before = useChatStore.getState().eventsBySession[SID];
    mergeEvents(SID, [evt('100')]);
    const after = useChatStore.getState().eventsBySession[SID];
    expect(after).toBe(before);
  });

  it('같은 fresh batch 안의 중복 id도 한 번만 저장한다', () => {
    const { mergeEvents } = useChatStore.getState();
    mergeEvents(SID, [evt('1'), evt('1'), evt('2'), evt('2')]);
    expect(getEvents().map((event) => event.id)).toEqual(['1', '2']);
  });

  // 🔴 핵심 회귀 — 증상 C 직접 검증.
  // ancestor 보강으로 페이지 1 응답에 U1(id='1')이 이미 포함되었고,
  // 사용자가 위로 스크롤하여 페이지 2(evt1..evt50)가 prepend되는 상황.
  // 현 prependEvents 코드는 [evt1..evt50, U1, evt51..evt100]을 만들어 사용자 메시지가
  // 자기보다 새로운 tool/assistant 메시지의 아래로 밀린다.
  // mergeSorted는 정렬 키 비교로 [U1, evt1..evt50, evt51..evt100]을 만들어야 한다.
  it('증상 C 회귀: ancestor U1 + 후속 페이지 prepend 시 U1이 가장 위에 보존된다', () => {
    const { mergeEvents } = useChatStore.getState();
    // 페이지 1: ancestor U1 + 후반부 events.
    const page1: SessionEvent[] = [
      evt('1', 'user_message'),
      ...Array.from({ length: 50 }, (_, k) => evt(String(51 + k))), // 51..100
    ];
    mergeEvents(SID, page1);

    // 페이지 2: U1(dedup) + 전반부 events.
    const page2: SessionEvent[] = [
      evt('1', 'user_message'),
      ...Array.from({ length: 50 }, (_, k) => evt(String(1 + k))), // 1..50  (U1 id=1 dedup)
    ];
    mergeEvents(SID, page2);

    const ids = getEvents().map((e) => e.id);
    // 첫 항목은 반드시 U1.
    expect(ids[0]).toBe('1');
    // 길이 = 100 (U1 + 99 distinct ids 2..100? actually U1 dedup → unique: 1, 2..50, 51..100 = 100).
    expect(ids).toHaveLength(100);
    // 정렬 보존: 숫자 ASC.
    const sorted = [...ids].sort((a, b) => Number(a) - Number(b));
    expect(ids).toEqual(sorted);
  });

  it('fallback id (NaN) 이벤트는 항상 끝(가장 최신)으로 정렬된다', () => {
    const { mergeEvents } = useChatStore.getState();
    mergeEvents(SID, [evt('10'), evt('20')]);
    mergeEvents(SID, [evt('text_delta-1234567890')]); // Number(...)=NaN → MAX_SAFE_INTEGER
    const ids = getEvents().map((e) => e.id);
    expect(ids).toEqual(['10', '20', 'text_delta-1234567890']);
  });

  it('라이브 SSE 단건 머지: 끝에 추가 (happy path)', () => {
    const { mergeEvents } = useChatStore.getState();
    mergeEvents(SID, [evt('1'), evt('2'), evt('3')]);
    mergeEvents(SID, [evt('4')]);
    expect(getEvents().map((e) => e.id)).toEqual(['1', '2', '3', '4']);
  });

  it('빈 입력은 state 변경 없음 (reference 동일)', () => {
    const { mergeEvents } = useChatStore.getState();
    mergeEvents(SID, [evt('1'), evt('2')]);
    const before = useChatStore.getState().eventsBySession[SID];
    mergeEvents(SID, []);
    const after = useChatStore.getState().eventsBySession[SID];
    expect(after).toBe(before);
  });

  it('정렬되지 않은 fresh 입력도 정렬되어 머지된다', () => {
    const { mergeEvents } = useChatStore.getState();
    mergeEvents(SID, [evt('5'), evt('1'), evt('3'), evt('2'), evt('4')]);
    expect(getEvents().map((e) => e.id)).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe('chatStore.streamingSlots — live delta append 제거', () => {
  beforeEach(() => {
    reset();
    useChatStore.setState({ streamingSlotsBySession: {} });
  });

  it('text_delta는 events 배열에 append하지 않고 assistant slot 최신값만 교체한다', () => {
    const { setStreamingEvent } = useChatStore.getState();

    setStreamingEvent(SID, 'assistant', {
      id: '10',
      type: 'text_delta',
      data: { text: 'Hel' },
    });
    setStreamingEvent(SID, 'assistant', {
      id: '11',
      type: 'text_delta',
      data: { text: 'Hello' },
    });

    expect(getEvents()).toEqual([]);
    expect(getStreamingSlots()?.assistant?.id).toBe('11');
    expect(getStreamingSlots()?.assistant?.data.text).toBe('Hello');
  });

  it('live-only app-server chunk는 history append 없이 assistant slot 내부에서 누적한다', () => {
    const { setStreamingEvent } = useChatStore.getState();

    setStreamingEvent(SID, 'assistant', liveAppDelta('a', 'item-a', 'Hel'));
    setStreamingEvent(SID, 'assistant', liveAppDelta('b', 'item-a', 'lo'));

    expect(getEvents()).toEqual([]);
    expect(getStreamingSlots()?.assistant?.id).toBe('b');
    expect(getStreamingSlots()?.assistant?.data.text).toBe('Hello');
  });

  it('v2 streamIdentity별 append/replace를 격리하고 snapshot replacement를 원자 적용한다', () => {
    const { setStreamingEvent, replaceAssistantStreamingEvents } =
      useChatStore.getState();
    const v2 = (
      identity: string,
      liveSeq: number,
      text: string,
      liveTextMode: 'append' | 'replace',
    ): SessionEvent => ({
      id: `live-${liveSeq}`,
      type: 'text_delta',
      data: { text, streamIdentity: identity, liveSeq, liveTextMode },
    });

    replaceAssistantStreamingEvents(SID, [
      v2('stream-a', 40, 'prefix-a', 'replace'),
      v2('stream-b', 40, 'prefix-b', 'replace'),
    ]);
    setStreamingEvent(SID, 'assistant', v2('stream-a', 41, '+append', 'append'));
    setStreamingEvent(SID, 'assistant', v2('stream-b', 42, 'replacement', 'replace'));

    expect(getStreamingSlots()?.assistantByStream).toMatchObject({
      'stream-a': { data: { text: 'prefix-a+append' } },
      'stream-b': { data: { text: 'replacement' } },
    });
    expect(getStreamingSlots()?.assistant).toBeUndefined();
  });

  it('v2 append chunk가 기존 prefix로 시작해도 계약대로 그대로 이어 붙인다', () => {
    const { setStreamingEvent } = useChatStore.getState();
    setStreamingEvent(SID, 'assistant', {
      id: 'snapshot-stream-a',
      type: 'text_delta',
      data: {
        text: 'ha',
        streamIdentity: 'stream-a',
        liveSeq: 40,
        liveTextMode: 'replace',
      },
    });
    setStreamingEvent(SID, 'assistant', {
      id: 'live-stream-a-41',
      type: 'text_delta',
      data: {
        text: 'happy',
        streamIdentity: 'stream-a',
        liveSeq: 41,
        liveTextMode: 'append',
      },
    });

    expect(getStreamingSlots()?.assistantByStream?.['stream-a']?.data.text)
      .toBe('hahappy');
  });

  it('동일한 빈 snapshot replacement는 store identity를 유지한다', () => {
    const before = useChatStore.getState();

    useChatStore.getState().replaceAssistantStreamingEvents(SID, []);

    expect(useChatStore.getState()).toBe(before);
  });

  it('identity가 있는 durable final은 일치하는 recovered stream만 원자적으로 비운다', () => {
    const { replaceAssistantStreamingEvents, mergeEvents } = useChatStore.getState();
    const recovered = (identity: string): SessionEvent => ({
      id: `snapshot-${identity}`,
      type: 'text_delta',
      data: {
        text: identity,
        streamIdentity: identity,
        liveSeq: 10,
        liveTextMode: 'replace',
      },
    });
    replaceAssistantStreamingEvents(SID, [recovered('stream-a'), recovered('stream-b')]);
    const snapshots: string[][] = [];
    const unsubscribe = useChatStore.subscribe((state) => {
      snapshots.push(Object.keys(
        state.streamingSlotsBySession[SID]?.assistantByStream ?? {},
      ));
    });

    mergeEvents(SID, [{
      id: '50',
      type: 'assistant_message',
      data: {
        content: 'final a',
        streamIdentity: 'stream-a',
        liveSeq: 11,
        liveTextMode: 'replace',
        _final_for_live_stream: true,
      },
    }]);
    unsubscribe();

    expect(getStreamingSlots()?.assistantByStream).toEqual({
      'stream-b': recovered('stream-b'),
    });
    expect(snapshots).toEqual([['stream-b']]);
    expect(getEvents()).toEqual([expect.objectContaining({ id: '50' })]);
  });

  it('snapshot boundary는 raw replay를 가리는 동안 text_end에 유지되고 durable final에 해제된다', () => {
    const {
      replaceAssistantStreamingEvents,
      finalizeStreamingEvent,
      mergeEvents,
    } = useChatStore.getState();
    const recovered: SessionEvent = {
      id: 'snapshot-stream-a',
      type: 'text_delta',
      data: {
        text: 'recovered prefix',
        streamIdentity: 'stream-a',
        liveSeq: 10,
        liveTextMode: 'replace',
      },
    };
    replaceAssistantStreamingEvents(SID, [recovered], ['stream-a']);

    finalizeStreamingEvent(SID, 'assistant', 'stream-a');
    expect(getStreamingSlots()?.assistantByStream?.['stream-a']).toBe(recovered);
    expect(getStreamingSlots()?.assistantSnapshotStreams).toEqual({
      'stream-a': true,
    });

    mergeEvents(SID, [{
      id: '50',
      type: 'assistant_message',
      data: {
        content: 'durable final',
        streamIdentity: 'stream-a',
        liveSeq: 11,
        liveTextMode: 'replace',
        _final_for_live_stream: true,
      },
    }]);
    expect(getStreamingSlots()).toBeUndefined();
  });

  it('capped snapshot identity도 partial 없이 boundary만 보존한다', () => {
    useChatStore.getState().replaceAssistantStreamingEvents(
      SID,
      [],
      ['capped-stream'],
    );

    expect(getStreamingSlots()).toEqual({
      assistantSnapshotStreams: { 'capped-stream': true },
    });
  });

  it('늦게 도착한 REST historical assistant는 현재 recovered stream을 지우지 않는다', () => {
    const { replaceAssistantStreamingEvents, mergeEvents } = useChatStore.getState();
    const recovered: SessionEvent = {
      id: 'snapshot-stream-a',
      type: 'text_delta',
      data: {
        text: 'live prefix',
        streamIdentity: 'stream-a',
        liveSeq: 10,
        liveTextMode: 'replace',
      },
    };
    replaceAssistantStreamingEvents(SID, [recovered]);

    mergeEvents(SID, [{
      id: '9',
      type: 'assistant_message',
      data: { content: 'older durable history' },
    }]);

    expect(getStreamingSlots()?.assistantByStream?.['stream-a']).toBe(recovered);
    expect(getEvents()).toEqual([expect.objectContaining({ id: '9' })]);
  });

  it('누적형 text_delta는 assistant slot을 최신 payload로 교체한다', () => {
    const { setStreamingEvent } = useChatStore.getState();

    setStreamingEvent(SID, 'assistant', {
      id: '10',
      type: 'text_delta',
      data: { text: 'Hel' },
    });
    setStreamingEvent(SID, 'assistant', {
      id: '11',
      type: 'text_delta',
      data: { text: 'Hello' },
    });

    expect(getEvents()).toEqual([]);
    expect(getStreamingSlots()?.assistant?.id).toBe('11');
    expect(getStreamingSlots()?.assistant?.data.text).toBe('Hello');
  });

  it('thinking_delta도 events 배열에 append하지 않고 thinking slot 최신값만 교체한다', () => {
    const { setStreamingEvent } = useChatStore.getState();

    setStreamingEvent(SID, 'thinking', {
      id: '20',
      type: 'thinking_delta',
      data: { thinking: '분석' },
    });
    setStreamingEvent(SID, 'thinking', {
      id: '21',
      type: 'thinking_delta',
      data: { thinking: '분석 중' },
    });

    expect(getEvents()).toEqual([]);
    expect(getStreamingSlots()?.thinking?.id).toBe('21');
    expect(getStreamingSlots()?.thinking?.data.thinking).toBe('분석 중');
  });

  it('stream 종료 시 slot의 최신 이벤트 1건만 history에 finalize한다', () => {
    const { setStreamingEvent, finalizeStreamingEvent } = useChatStore.getState();

    setStreamingEvent(SID, 'assistant', {
      id: '30',
      type: 'text_delta',
      data: { text: 'old' },
    });
    setStreamingEvent(SID, 'assistant', {
      id: '31',
      type: 'text_delta',
      data: { text: 'latest' },
    });
    finalizeStreamingEvent(SID, 'assistant');

    expect(getEvents().map((e) => [e.id, e.type, e.data.text])).toEqual([
      ['31', 'text_delta', 'latest'],
    ]);
    expect(getStreamingSlots()?.assistant).toBeUndefined();
  });

  it('assistant_message merge는 final event 추가와 assistant slot clear를 원자적으로 처리한다', () => {
    const { setStreamingEvent, mergeEvents } = useChatStore.getState();

    setStreamingEvent(SID, 'assistant', {
      id: '40',
      type: 'text_delta',
      data: { text: 'live' },
    });
    const snapshots: Array<{ hasFinal: boolean; hasSlot: boolean }> = [];
    const unsubscribe = useChatStore.subscribe((state) => {
      snapshots.push({
        hasFinal: (state.eventsBySession[SID] ?? []).some(
          (event) => event.id === '41' && event.type === 'assistant_message',
        ),
        hasSlot: Boolean(state.streamingSlotsBySession[SID]?.assistant),
      });
    });

    mergeEvents(SID, [
      { id: '41', type: 'assistant_message', data: { content: 'final' } },
    ]);
    unsubscribe();

    expect(getEvents().map((e) => [e.id, e.type])).toEqual([
      ['41', 'assistant_message'],
    ]);
    expect(getStreamingSlots()?.assistant).toBeUndefined();
    expect(snapshots).toEqual([{ hasFinal: true, hasSlot: false }]);
    expect(snapshots).not.toContainEqual({ hasFinal: false, hasSlot: false });
  });

  it('clearSession은 streaming slot도 함께 비운다', () => {
    const { setStreamingEvent, clearSession } = useChatStore.getState();
    setStreamingEvent(SID, 'assistant', {
      id: '50',
      type: 'text_delta',
      data: { text: 'live' },
    });
    expect(getStreamingSlots()?.assistant).toBeDefined();
    clearSession(SID);
    expect(getStreamingSlots()).toBeUndefined();
  });
});

describe('chatStore.claudeRuntime schedules', () => {
  beforeEach(() => {
    reset();
    useChatStore.setState({ claudeRuntimeBySession: {} });
  });

  it('schedule SSE update/delete를 반영하고 다음 active 실행 시각을 계산한다', () => {
    const { applyClaudeRuntimeEvent } = useChatStore.getState();

    applyClaudeRuntimeEvent(SID, 'claude_runtime_schedule_updated', {
      schedule_id: 'sched-late',
      session_id: SID,
      schedule_kind: 'cron',
      status: 'active',
      prompt: 'later',
      recurring: true,
      next_run_at: '2026-01-01T01:00:00.000Z',
      timestamp: 10,
    });
    applyClaudeRuntimeEvent(SID, 'claude_runtime_schedule_updated', {
      schedule_id: 'sched-soon',
      session_id: SID,
      schedule_kind: 'wakeup',
      status: 'active',
      prompt: 'soon',
      recurring: false,
      next_run_at: '2026-01-01T00:30:00.000Z',
      timestamp: 11,
    });

    expect(useChatStore.getState().claudeRuntimeBySession[SID]).toMatchObject({
      nextScheduleRunAt: '2026-01-01T00:30:00.000Z',
      schedules: {
        'sched-late': { scheduleId: 'sched-late', kind: 'cron' },
        'sched-soon': { scheduleId: 'sched-soon', kind: 'wakeup' },
      },
    });

    applyClaudeRuntimeEvent(SID, 'claude_runtime_schedule_deleted', {
      schedule_id: 'sched-soon',
      session_id: SID,
      status: 'cancelled',
      timestamp: 12,
    });

    expect(useChatStore.getState().claudeRuntimeBySession[SID]).toMatchObject({
      nextScheduleRunAt: '2026-01-01T01:00:00.000Z',
      schedules: {
        'sched-late': { scheduleId: 'sched-late' },
      },
    });
    expect(
      useChatStore.getState().claudeRuntimeBySession[SID].schedules['sched-soon'],
    ).toBeUndefined();
  });

  it('schedule 목록 refresh는 task 상태를 보존하며 store 정본을 교체한다', () => {
    const { setClaudeRuntimeTasks, setClaudeRuntimeSchedules } = useChatStore.getState();

    setClaudeRuntimeTasks(SID, {
      sessionId: SID,
      sessionState: 'running',
      runtimeSessionId: 'claude-sess-1',
      updatedAt: 10,
      tasks: [{ taskId: 'bg-1', status: 'running', updatedAt: 10 }],
    });
    setClaudeRuntimeSchedules(SID, {
      sessionId: SID,
      nextRunAt: '2026-01-01T00:30:00.000Z',
      schedules: [{
        scheduleId: 'sched-1',
        sessionId: SID,
        kind: 'wakeup',
        status: 'active',
        prompt: 'wake',
        nextRunAt: '2026-01-01T00:30:00.000Z',
      }],
    });

    expect(useChatStore.getState().claudeRuntimeBySession[SID]).toMatchObject({
      sessionState: 'running',
      tasks: { 'bg-1': { taskId: 'bg-1' } },
      schedules: { 'sched-1': { scheduleId: 'sched-1' } },
      nextScheduleRunAt: '2026-01-01T00:30:00.000Z',
    });
  });

  it('task 목록 refresh가 미지원 서버 응답이면 signal 상태를 보존한다', () => {
    const { applyClaudeRuntimeEvent, setClaudeRuntimeTasks } = useChatStore.getState();

    applyClaudeRuntimeEvent(SID, 'claude_runtime_notification', {
      notification_id: 'notif-1',
      source: 'system',
      message: 'Approval needed',
      timestamp: 13,
    });
    setClaudeRuntimeTasks(SID, {
      sessionId: SID,
      sessionState: 'running',
      runtimeSessionId: 'claude-sess-1',
      updatedAt: 14,
      tasks: [{ taskId: 'bg-1', status: 'running', updatedAt: 14 }],
    });

    expect(useChatStore.getState().claudeRuntimeBySession[SID]).toMatchObject({
      tasks: { 'bg-1': { taskId: 'bg-1' } },
      notifications: {
        'notif-1': {
          notificationId: 'notif-1',
          message: 'Approval needed',
        },
      },
    });
  });
});

describe('chatStore.lastEventIdBySession', () => {
  beforeEach(() => reset());

  it('lastEventId는 숫자 cursor 기준으로 뒤로 이동하지 않는다', () => {
    const { setLastEventId } = useChatStore.getState();

    setLastEventId(SID, '50');
    setLastEventId(SID, '42');
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('50');

    setLastEventId(SID, '51');
    expect(useChatStore.getState().lastEventIdBySession[SID]).toBe('51');
  });
});

describe('chatStore.pendingOptimistic — events 분리 슬롯 (RN ScrollView Caveat 1 회피)', () => {
  beforeEach(() => {
    reset();
    useChatStore.setState({ pendingOptimisticBySession: {} });
  });

  // 🔴 P0 직격 — events 배열에 NaN sortKey 항목이 들어가면 reordering 발생.
  // 슬롯 분리 후에는 events에 finite id만 들어가야 한다.
  it('events 배열에는 sortKey가 NaN인 항목(optimistic id)이 절대 들어가지 않는다', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    setPendingOptimistic(SID, {
      id: 'optimistic-user-1234567890-abc',
      type: 'user_message',
      data: { text: '안녕하세요' },
    });
    mergeEvents(SID, [
      { id: '5', type: 'user_message', data: { text: '안녕하세요' } },
      { id: '10', type: 'text_delta', data: {} },
    ]);
    const ids = getEvents().map((e) => e.id);
    for (const id of ids) {
      expect(Number.isFinite(Number(id))).toBe(true);
    }
  });

  // 🔴 P0 핵심 — reordering 회피 검증.
  // optimistic insert → 라이브 SSE(text_delta id=10) → 진짜 user_message(id=5) 도착 시
  // events 배열은 [real(5), other(10)] ASC 그대로 유지. opt은 슬롯에서 비워진다.
  it('시나리오 A: opt 슬롯 + 라이브 텍스트(id=10) → real(id=5) 도착 시 events는 ASC로 안정', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    // 1) opt 발사 (슬롯 set)
    setPendingOptimistic(SID, {
      id: 'optimistic-user-9999-abc',
      type: 'user_message',
      data: { text: '안녕하세요' },
    });
    // 2) 라이브 SSE: 다른 이벤트(id=10)
    mergeEvents(SID, [{ id: '10', type: 'text_delta', data: {} }]);
    // events에는 라이브만, 슬롯은 그대로.
    expect(getEvents().map((e) => e.id)).toEqual(['10']);
    expect(getSlot()).toBeDefined();

    // 3) 진짜 user_message(id=5)가 늦게 도착 → events ASC로 합류, 슬롯 비움.
    mergeEvents(SID, [
      { id: '5', type: 'user_message', data: { text: '안녕하세요' } },
    ]);
    expect(getEvents().map((e) => e.id)).toEqual(['5', '10']);
    expect(getSlot()).toBeUndefined();
  });

  // 시나리오 B: events에 같은 text의 real이 이미 있으면 setPendingOptimistic은 슬롯에 안 넣음.
  it('시나리오 B: events에 같은 text의 real이 이미 있으면 슬롯에 들어가지 않는다', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    mergeEvents(SID, [
      { id: '42', type: 'user_message', data: { text: '안녕하세요' } },
    ]);
    setPendingOptimistic(SID, {
      id: 'optimistic-user-9999-xyz',
      type: 'user_message',
      data: { text: '안녕하세요' },
    });
    expect(getSlot()).toBeUndefined();
    expect(getEvents().map((e) => e.id)).toEqual(['42']);
  });

  // intervene 실패 시 슬롯 명시 롤백.
  it('clearPendingOptimistic: 슬롯만 비우고 events에는 영향 없음', () => {
    const { mergeEvents, setPendingOptimistic, clearPendingOptimistic } =
      useChatStore.getState();
    mergeEvents(SID, [{ id: '7', type: 'text_delta', data: {} }]);
    setPendingOptimistic(SID, {
      id: 'optimistic-user-1-ccc',
      type: 'intervention_sent',
      data: { text: '실패할 메시지' },
    });
    expect(getSlot()).toBeDefined();
    const eventsBefore = useChatStore.getState().eventsBySession[SID];
    clearPendingOptimistic(SID);
    expect(getSlot()).toBeUndefined();
    // events 참조 동일 (영향 없음).
    expect(useChatStore.getState().eventsBySession[SID]).toBe(eventsBefore);
  });

  it('clearPendingOptimistic: 존재하지 않는 슬롯은 무시 (state reference 유지)', () => {
    const { clearPendingOptimistic } = useChatStore.getState();
    const before = useChatStore.getState().pendingOptimisticBySession;
    clearPendingOptimistic(SID);
    const after = useChatStore.getState().pendingOptimisticBySession;
    expect(after).toBe(before);
  });

  it('intervention_sent도 같은 text의 real이 도착하면 슬롯에서 비워진다', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    setPendingOptimistic(SID, {
      id: 'optimistic-user-1-yyy',
      type: 'intervention_sent',
      data: { text: '잠깐만요' },
    });
    mergeEvents(SID, [
      { id: '50', type: 'intervention_sent', data: { text: '잠깐만요' } },
    ]);
    expect(getEvents().map((e) => e.id)).toEqual(['50']);
    expect(getSlot()).toBeUndefined();
  });

  it('text가 다른 real이 도착해도 슬롯은 보존된다 (false positive 방지)', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    setPendingOptimistic(SID, {
      id: 'optimistic-user-1-aaa',
      type: 'user_message',
      data: { text: '첫 번째' },
    });
    mergeEvents(SID, [
      { id: '10', type: 'user_message', data: { text: '두 번째' } },
    ]);
    expect(getEvents().map((e) => e.id)).toEqual(['10']);
    expect(getSlot()).toBeDefined();
    expect(getSlot()?.id).toBe('optimistic-user-1-aaa');
  });

  it('real이지만 type이 다르면 슬롯 보존 (예: text_delta는 user_message가 아님)', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    setPendingOptimistic(SID, {
      id: 'optimistic-user-1-bbb',
      type: 'user_message',
      data: { text: '같은 텍스트' },
    });
    mergeEvents(SID, [
      { id: '20', type: 'text_delta', data: { text: '같은 텍스트' } },
    ]);
    expect(getSlot()).toBeDefined();
    expect(getEvents().map((e) => e.id)).toEqual(['20']);
  });

  it('clearSession: 슬롯도 함께 비워진다', () => {
    const { setPendingOptimistic, clearSession } = useChatStore.getState();
    setPendingOptimistic(SID, {
      id: 'optimistic-user-1-zzz',
      type: 'user_message',
      data: { text: '데이터' },
    });
    expect(getSlot()).toBeDefined();
    clearSession(SID);
    expect(getSlot()).toBeUndefined();
  });

  // 🔴 P0 — resume 경로 회귀.
  // 옵티미스틱은 사용자가 send를 누른 시점에 'intervention_sent'(주황)로 만들어졌으나,
  // 서버는 완료된 세션에 대한 intervene을 auto-resume → user_message(파랑)로 broadcast한다
  // (task_manager.add_intervention L855: RUNNING이 아니면 create_task 경로).
  // 두 type이 다르더라도 사용자 발화 클래스(user_message OR intervention_sent) + 텍스트
  // 일치이면 슬롯이 비워져야 한다. 그렇지 않으면 화면에 두 말풍선이 동시에 보인다.
  it('🔴 resume 경로: opt intervention_sent + real user_message 동일 텍스트 → 슬롯 비움', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    setPendingOptimistic(SID, {
      id: 'optimistic-user-1-rrr',
      type: 'intervention_sent',
      data: { text: '다시 시작합니다' },
    });
    mergeEvents(SID, [
      { id: '99', type: 'user_message', data: { text: '다시 시작합니다' } },
    ]);
    expect(getSlot()).toBeUndefined();
    expect(getEvents().map((e) => e.id)).toEqual(['99']);
  });

  // 역방향 케이스 — 실제 서버에서 발동하지 않는 조합(서버는 running일 때만 intervention_sent를 emit하고,
  // running일 때 user_message는 emit하지 않는다). type-agnostic 완화의 대칭성 보장 회귀.
  it('역방향: opt user_message + real intervention_sent 동일 텍스트 → 슬롯 비움 (대칭성)', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    setPendingOptimistic(SID, {
      id: 'optimistic-user-1-sym',
      type: 'user_message',
      data: { text: '대칭 테스트' },
    });
    mergeEvents(SID, [
      { id: '77', type: 'intervention_sent', data: { text: '대칭 테스트' } },
    ]);
    expect(getSlot()).toBeUndefined();
    expect(getEvents().map((e) => e.id)).toEqual(['77']);
  });

  // setPendingOptimistic 시나리오 B 가드도 type-agnostic.
  // events에 user_message(real)가 같은 텍스트로 있으면, opt type이 intervention_sent여도
  // 슬롯에 들어가지 않는다 (시나리오 B: SSE 선도착 race 후 opt 시도 시).
  it('시나리오 B type-agnostic: events에 user_message real 있으면 intervention_sent opt도 슬롯 차단', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    mergeEvents(SID, [
      { id: '42', type: 'user_message', data: { text: '안녕' } },
    ]);
    setPendingOptimistic(SID, {
      id: 'optimistic-user-1-b',
      type: 'intervention_sent',
      data: { text: '안녕' },
    });
    expect(getSlot()).toBeUndefined();
    expect(getEvents().map((e) => e.id)).toEqual(['42']);
  });

  // 텍스트가 다르면 type 무관 슬롯 보존 (false positive 방지 회귀).
  it('false positive 방지: 다른 텍스트의 user-class real이 와도 슬롯은 type 무관하게 보존', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    setPendingOptimistic(SID, {
      id: 'optimistic-user-1-fp',
      type: 'intervention_sent',
      data: { text: '첫 번째' },
    });
    mergeEvents(SID, [
      { id: '10', type: 'user_message', data: { text: '두 번째' } },
    ]);
    expect(getSlot()).toBeDefined();
    expect(getSlot()?.id).toBe('optimistic-user-1-fp');
    expect(getEvents().map((e) => e.id)).toEqual(['10']);
  });

  // 기존 가드(L230-242)와 동치 — type-agnostic 완화 후에도 user-class가 아닌 이벤트는
  // isRealUserMessage 1차 가드에서 걸러진다. text_delta·tool_start 등은 영향 없음.
  it('non-user-class real(text_delta)이 같은 텍스트로 와도 슬롯 보존 (isRealUserMessage 가드)', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    setPendingOptimistic(SID, {
      id: 'optimistic-user-1-nuc',
      type: 'user_message',
      data: { text: '같은 텍스트' },
    });
    mergeEvents(SID, [
      { id: '20', type: 'text_delta', data: { text: '같은 텍스트' } },
    ]);
    expect(getSlot()).toBeDefined();
    expect(getEvents().map((e) => e.id)).toEqual(['20']);
  });
});

describe('pickOptimisticVariant — handleSend 분기 시그널 함수', () => {
  it("status === 'running'이면 intervention_sent (서버 intervention_queue 경로 거울)", () => {
    expect(pickOptimisticVariant('running')).toBe('intervention_sent');
  });

  it("status가 running이 아니면 user_message (서버 auto-resume 경로 거울)", () => {
    expect(pickOptimisticVariant('completed')).toBe('user_message');
    expect(pickOptimisticVariant('error')).toBe('user_message');
    expect(pickOptimisticVariant('idle')).toBe('user_message');
    expect(pickOptimisticVariant('interrupted')).toBe('user_message');
  });

  it('status가 undefined여도 안전하게 user_message로 fallback', () => {
    expect(pickOptimisticVariant(undefined)).toBe('user_message');
  });
});

describe('setPendingOptimistic anchor', () => {
  beforeEach(() => {
    reset();
    useChatStore.setState({ pendingOptimisticBySession: {} });
  });

  it('기존 이벤트가 없으면 anchor가 null이다 (새 세션 첫 prompt)', () => {
    const { setPendingOptimistic } = useChatStore.getState();
    setPendingOptimistic(
      SID,
      createOptimisticUserEvent('첫 prompt', 'user_message'),
    );
    expect(getOptimisticAfterEventId(getSlot()!)).toBeNull();
  });

  it('기존 이벤트가 있으면 전송 시점의 마지막 서버 이벤트 id에 anchor한다', () => {
    const { mergeEvents, setPendingOptimistic } = useChatStore.getState();
    mergeEvents(SID, [
      { id: '5', type: 'user_message', data: { text: '이전' } },
      { id: '12', type: 'tool_start', data: { tool_use_id: 'tu_old' } },
    ]);
    setPendingOptimistic(
      SID,
      createOptimisticUserEvent('일반 전송', 'intervention_sent'),
    );
    expect(getOptimisticAfterEventId(getSlot()!)).toBe('12');
  });
});

describe('chatStore.pendingFirstMessage', () => {
  beforeEach(() => {
    useChatStore.setState({ pendingFirstMessageBySession: {} });
  });

  it('set한 뒤 consume하면 값이 반환되고 이후 호출은 undefined', () => {
    const { setPendingFirstMessage, consumePendingFirstMessage } =
      useChatStore.getState();
    setPendingFirstMessage(SID, '첫 인사');
    expect(consumePendingFirstMessage(SID)).toBe('첫 인사');
    expect(consumePendingFirstMessage(SID)).toBeUndefined();
  });

  it('빈 문자열도 set/consume 가능 (text === "" 자체는 호출자가 가드)', () => {
    const { setPendingFirstMessage, consumePendingFirstMessage } =
      useChatStore.getState();
    setPendingFirstMessage(SID, '');
    expect(consumePendingFirstMessage(SID)).toBe('');
  });
});

describe('chatStore.claudeRuntimeBySession', () => {
  beforeEach(() => reset());

  it('P0-A Claude runtime wire를 background task 상태로 누적한다', () => {
    const { applyClaudeRuntimeEvent } = useChatStore.getState();

    applyClaudeRuntimeEvent(SID, 'claude_runtime_session_state', {
      state: 'running',
      session_id: 'claude-sess-1',
      timestamp: 10,
    });
    applyClaudeRuntimeEvent(SID, 'claude_runtime_task_started', {
      task_id: 'bg-1',
      tool_use_id: 'toolu-bash',
      description: 'Background Bash task',
      task_type: 'bash',
      timestamp: 11,
    });
    applyClaudeRuntimeEvent(SID, 'claude_runtime_task_updated', {
      task_id: 'bg-1',
      patch: {
        status: 'running',
        is_backgrounded: true,
        output_file: '/tmp/bg-1.out',
        summary: 'sleeping',
      },
      timestamp: 12,
    });
    applyClaudeRuntimeEvent(SID, 'claude_runtime_task_created', {
      task_id: 'sdk-task-1',
      subject: 'Investigate queue',
      description: 'Check pending queue',
      teammate_name: 'analyst',
      team_name: 'runtime',
      timestamp: 13,
    });
    applyClaudeRuntimeEvent(SID, 'claude_runtime_task_completed', {
      task_id: 'sdk-task-1',
      subject: 'Investigate queue',
      description: 'Check pending queue',
      teammate_name: 'analyst',
      team_name: 'runtime',
      timestamp: 14,
    });

    expect(useChatStore.getState().claudeRuntimeBySession[SID]).toMatchObject({
      sessionState: 'running',
      runtimeSessionId: 'claude-sess-1',
      tasks: {
        'bg-1': {
          taskId: 'bg-1',
          status: 'running',
          toolUseId: 'toolu-bash',
          taskType: 'bash',
          outputFile: '/tmp/bg-1.out',
          summary: 'sleeping',
          isBackgrounded: true,
        },
        'sdk-task-1': {
          taskId: 'sdk-task-1',
          status: 'completed',
          subject: 'Investigate queue',
          description: 'Check pending queue',
          teammateName: 'analyst',
          teamName: 'runtime',
        },
      },
    });
  });

  it('plan/worktree mode 상태를 task row 없이 누적한다', () => {
    const { applyClaudeRuntimeEvent } = useChatStore.getState();

    applyClaudeRuntimeEvent(SID, 'claude_runtime_mode_state', {
      mode: 'plan',
      active: true,
      source: 'tool_use',
      tool_use_id: 'toolu-plan',
      tool_name: 'EnterPlanMode',
      timestamp: 20,
    });
    applyClaudeRuntimeEvent(SID, 'claude_runtime_mode_state', {
      mode: 'worktree',
      active: false,
      source: 'tool_use',
      tool_use_id: 'toolu-worktree',
      tool_name: 'ExitWorktree',
      worktree_action: 'keep',
      timestamp: 21,
    });
    applyClaudeRuntimeEvent(SID, 'claude_runtime_hook_event', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      timestamp: 22,
    });

    expect(useChatStore.getState().claudeRuntimeBySession[SID]).toMatchObject({
      planMode: {
        active: true,
        source: 'tool_use',
        toolUseId: 'toolu-plan',
        toolName: 'EnterPlanMode',
      },
      worktreeMode: {
        active: false,
        source: 'tool_use',
        toolUseId: 'toolu-worktree',
        toolName: 'ExitWorktree',
        worktreeAction: 'keep',
      },
      tasks: {},
    });
  });

  it('runtime notification, remote trigger, transcript mirror 상태를 누적한다', () => {
    const { applyClaudeRuntimeEvent } = useChatStore.getState();

    applyClaudeRuntimeEvent(SID, 'claude_runtime_notification', {
      notification_id: 'notif-1',
      source: 'tool_use',
      title: 'Approval',
      message: 'Confirm the handoff',
      notification_type: 'permission',
      session_id: 'claude-sess-1',
      timestamp: 30,
    });
    applyClaudeRuntimeEvent(SID, 'claude_runtime_remote_trigger', {
      trigger_id: 'remote-1',
      source: 'message_origin',
      origin_kind: 'peer',
      origin_name: 'orchestrator',
      prompt: 'Continue the session',
      session_id: 'claude-sess-1',
      timestamp: 31,
    });
    applyClaudeRuntimeEvent(SID, 'claude_runtime_transcript_mirror_error', {
      mirror_id: 'mirror-1',
      session_id: 'claude-sess-1',
      project_key: 'soulstream',
      transcript_session_id: 'claude-sess-1',
      error: 'write failed',
      timestamp: 32,
    });

    expect(useChatStore.getState().claudeRuntimeBySession[SID]).toMatchObject({
      runtimeSessionId: 'claude-sess-1',
      notifications: {
        'notif-1': {
          notificationId: 'notif-1',
          source: 'tool_use',
          title: 'Approval',
          message: 'Confirm the handoff',
          notificationType: 'permission',
        },
      },
      remoteTriggers: {
        'remote-1': {
          triggerId: 'remote-1',
          source: 'message_origin',
          originKind: 'peer',
          originName: 'orchestrator',
          prompt: 'Continue the session',
        },
      },
      transcriptMirror: {
        mirrorId: 'mirror-1',
        errorCount: 1,
        lastError: 'write failed',
      },
    });
  });
});
