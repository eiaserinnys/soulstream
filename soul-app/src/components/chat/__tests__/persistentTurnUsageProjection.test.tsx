import { renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { groupChatEvents } from '../groupChatEvents';
import { projectPersistentTurnUsage } from '../persistentTurnUsageProjection';
import { useChatRenderItems } from '../useChatRenderItems';

function event(id: string, type: string, data: Record<string, unknown> = {}): SessionEvent {
  return { id, type: type as SessionEvent['type'], data };
}

function project(events: SessionEvent[], mode: 'collapsed' | 'expanded' | 'hidden' = 'collapsed') {
  return projectPersistentTurnUsage(groupChatEvents(events), events, mode as never);
}

function turnEndItems(items: ReturnType<typeof project>) {
  return items.filter((item) => (item.kind as string) === 'turn-end-captions') as Array<{
    kind: 'turn-end-captions';
    key: string;
    usage?: { title: string; expandedTitle?: string; lines: string[] };
    summaries?: Array<{ content: string; key: string }>;
  }>;
}

describe('projectPersistentTurnUsage', () => {
  test('pairs each completion with its own preceding context and preserves terminal keys', () => {
    const events = [
      event('10', 'context_usage', {
        used_tokens: 630_000, max_tokens: 1_000_000, percent: 63, estimated: true,
      }),
      event('11', 'complete', {
        usage: { input_tokens: 6, cache_read_input_tokens: 645_361, output_tokens: 6_139 },
        turn_cost_usd: 0.621749, session_cost_usd: 17.91,
      }),
      event('12', 'user_message', { text: '다음 턴' }),
      event('13', 'context_usage', {
        used_tokens: 220_000, max_tokens: 1_000_000, percent: 22,
      }),
      event('14', 'complete', {
        usage: { input_tokens: 50, output_tokens: 10 }, turn_cost_usd: 0.05,
      }),
    ];

    const items = project(events);
    const usageItems = items.filter((item) => item.kind === 'turn-end-captions' && item.usage);

    expect(usageItems.map((item) => item.key)).toEqual(['evt-11', 'evt-14']);
    expect(usageItems.map((item) => item.kind === 'turn-end-captions' ? item.usage?.title : undefined)).toEqual([
      '컨텍스트 약 63.0% · 정가 $0.62',
      '컨텍스트 22.0% · 정가 $0.05',
    ]);
    expect(usageItems[0]).toMatchObject({
      usage: {
        expandedTitle: '컨텍스트 약 630,000 / 1,000,000 (63.0%)',
        lines: [
          '턴 완료 · 입력 645,367 (캐시 645,361) · 출력 6,139 · 정가 $0.62 (세션 $17.91)',
        ],
      },
    });
    expect(items.filter((item) => item.kind === 'event' && item.event.type === 'context_usage'))
      .toHaveLength(0);
  });

  test('hides a completion when its usage, cost, and context produce no displayable value', () => {
    const events = [
      event('30', 'complete', { result: '답변 완료' }),
      event('31', 'user_message', { text: '다음 요청' }),
    ];

    const items = project(events);

    expect(items.some((item) => item.kind === 'turn-end-captions')).toBe(false);
    expect(items.some((item) => item.kind === 'event' && item.event.id === '30')).toBe(false);
    expect(items.map((item) => item.key)).toEqual(['evt-31']);
  });

  test('keeps an error event, adds its received context below it, and omits context without a terminal', () => {
    const errorEvent = event('21', 'error', { message: '응답 생성에 실패했습니다.' });
    const events = [
      event('20', 'context_usage', {
        used_tokens: 415_000, max_tokens: 1_000_000, percent: 41.5, estimated: true,
      }),
      errorEvent,
      event('22', 'context_usage', {
        used_tokens: 500_000, max_tokens: 1_000_000, percent: 50,
      }),
    ];

    const items = project(events);
    const errorIndex = items.findIndex((item) => item.kind === 'event' && item.event.id === '21');
    expect(items[errorIndex]).toMatchObject({ kind: 'event', event: errorEvent, key: 'evt-21' });
    expect(items[errorIndex]).toMatchObject({
      turnUsageCaption: {
        title: '컨텍스트 약 41.5%',
        expandedTitle: '컨텍스트 약 415,000 / 1,000,000 (41.5%)',
        lines: [],
      },
    });
    expect(items.some((item) => item.kind === 'turn-end-captions')).toBe(false);
    expect(items.some((item) => item.kind === 'event' && item.event.id === '22')).toBe(false);
  });

  test.each(['collapsed', 'expanded'] as const)('passes the %s mode to error captions', (mode) => {
    const events = [
      event('50', 'context_usage', { used_tokens: 41_500, max_tokens: 100_000, percent: 41.5 }),
      event('51', 'error', { message: '오류 본문 유지' }),
    ];

    const error = project(events, mode).find((item) => item.key === 'evt-51');

    expect(error).toMatchObject({ kind: 'event', turnUsageMode: mode, turnUsageCaption: expect.any(Object) });
  });

  test('hidden mode keeps the error event body without a usage caption', () => {
    const events = [
      event('52', 'context_usage', { used_tokens: 41_500, max_tokens: 100_000, percent: 41.5 }),
      event('53', 'error', { message: '오류 본문 유지' }),
    ];

    const error = project(events, 'hidden').find((item) => item.key === 'evt-53');
    expect(error).toMatchObject({ key: 'evt-53', kind: 'event' });
    expect(error?.kind === 'event' ? error.turnUsageCaption : null).toBeUndefined();
  });

  test('setting off removes only usage rows while retaining errors and other events', () => {
    const errorEvent = event('33', 'error', { message: '오류는 남습니다.' });
    const events = [
      event('30', 'user_message', { text: '요청' }),
      event('31', 'context_usage', { used_tokens: 10, max_tokens: 100, percent: 10 }),
      event('32', 'complete', { usage: { input_tokens: 5, output_tokens: 2 }, turn_cost_usd: 0.1 }),
      event('33', 'error', { message: '오류는 남습니다.' }),
      event('34', 'context_usage', { used_tokens: 20, max_tokens: 100, percent: 20 }),
    ];

    const items = project(events, 'hidden');

    expect(items.map((item) => item.key)).toEqual(['evt-30', 'evt-33']);
    expect(items.find((item) => item.key === 'evt-33')).toMatchObject({
      kind: 'event', event: errorEvent,
    });
    expect(items.some((item) => item.kind === 'turn-end-captions')).toBe(false);
  });

  test.each([
    ['collapsed', 'collapsed'],
    ['expanded', 'expanded'],
  ] as const)('passes the %s mode to completion captions', (mode, expectedMode) => {
    const items = project([
      event('41', 'complete', { usage: { input_tokens: 5, output_tokens: 2 }, turn_cost_usd: 0.1 }),
    ], mode);

    expect(turnEndItems(items)).toEqual([
      expect.objectContaining({ key: 'evt-41', turnUsageMode: expectedMode, usage: expect.any(Object) }),
    ]);
  });

  test('hidden mode keeps a completion row when a persistent instruction was recorded', () => {
    const events = [
      event('1', 'user_message', { input_id: 'input-1', text: '기억할 내용' }),
      event('2', 'assistant_message', { text: '기록했습니다.' }),
      event('3', 'complete', { usage: { input_tokens: 5, output_tokens: 2 }, turn_cost_usd: 0.1 }),
      event('4', 'turn_summary', { content: '요약', final_response_event_id: 2, parent_event_id: 2 }),
      event('5', 'debug', { kind: 'persistent_instruction_recorded', input_id: 'input-1', instructions: [{
        id: 'instruction-1', text: '기억할 내용', source_turns: ['T1'], action: 'updated',
      }] }),
    ];

    const items = project(events, 'hidden');

    expect(turnEndItems(items)).toEqual([
      expect.objectContaining({
        key: 'evt-3',
        turnUsageMode: 'hidden',
        summaries: [expect.objectContaining({ content: '요약' })],
        persistentInstructionRecorded: expect.objectContaining({
          instructions: [expect.objectContaining({ text: '기억할 내용' })],
        }),
      }),
    ]);
    expect(turnEndItems(items)[0]?.usage).toBeUndefined();
  });

  test('moves a turn summary to the first complete after its final response', () => {
    const events = [
      event('1', 'user_message', { text: '질문' }),
      event('2', 'assistant_message', { text: '답변' }),
      event('3', 'complete', { usage: { input_tokens: 10, output_tokens: 2 }, turn_cost_usd: 0.4 }),
      event('4', 'user_message', { text: '다음 질문' }),
      event('40', 'turn_summary', { content: '턴 요약 본문', final_response_event_id: 2, parent_event_id: 2 }),
    ];

    const items = project(events);

    expect(items.map((item) => item.key)).toEqual(['evt-1', 'evt-2', 'evt-3', 'evt-4']);
    expect(turnEndItems(items)).toEqual([
      expect.objectContaining({
        key: 'evt-3',
        usage: expect.objectContaining({ title: '정가 $0.40' }),
        summaries: [expect.objectContaining({ key: 'turn-summary-40', content: '턴 요약 본문' })],
      }),
    ]);
    const responseRow = items.find((item) => item.key === 'evt-2');
    expect(responseRow?.kind).toBe('event');
    if (responseRow?.kind === 'event') expect(responseRow.summaries).toBeUndefined();
  });

  test('keeps a summary separate when a boundary precedes the first complete', () => {
    const events = [
      event('2', 'assistant_message', { text: '이전 답변' }),
      event('3', 'intervention_sent', { text: '새 입력' }),
      event('4', 'complete', { usage: { input_tokens: 10, output_tokens: 2 }, turn_cost_usd: 0.4 }),
      event('40', 'turn_summary', { content: '이전 턴 요약', final_response_event_id: 2, parent_event_id: 2 }),
    ];

    const items = project(events);

    expect(turnEndItems(items)).toEqual([
      expect.objectContaining({ key: 'turn-summary-40', summaries: [expect.objectContaining({ content: '이전 턴 요약' })] }),
      expect.objectContaining({ key: 'evt-4', usage: expect.any(Object) }),
    ]);
  });

  test('does not pair across a hidden generation boundary', () => {
    const events = [
      event('2', 'assistant_message', { text: '이전 답변' }),
      event('3', 'generation_started', { generation: 2 }),
      event('4', 'complete', { usage: { input_tokens: 10, output_tokens: 2 }, turn_cost_usd: 0.4 }),
      event('40', 'turn_summary', { content: '이전 턴 요약', final_response_event_id: 2, parent_event_id: 2 }),
    ];

    const items = project(events);

    expect(items.map((item) => item.key)).toEqual(['evt-2', 'turn-summary-40', 'evt-4']);
    expect(turnEndItems(items)).toEqual([
      expect.objectContaining({ key: 'turn-summary-40', summaries: [expect.objectContaining({ content: '이전 턴 요약' })] }),
      expect.objectContaining({ key: 'evt-4', usage: expect.any(Object) }),
    ]);
  });

  test('keeps a summary-only row at the current position when its complete is outside loaded history', () => {
    const events = [
      event('2', 'assistant_message', { text: '로드된 응답' }),
      event('40', 'turn_summary', { content: '페이지 경계 요약', final_response_event_id: 90, parent_event_id: 2 }),
    ];

    const items = project(events);

    expect(items.map((item) => item.key)).toEqual(['evt-2', 'turn-summary-40']);
    expect(turnEndItems(items)).toEqual([
      expect.objectContaining({ key: 'turn-summary-40', summaries: [expect.objectContaining({ content: '페이지 경계 요약' })] }),
    ]);
  });

  test('retains the completion row for its summary when usage display is off', () => {
    const events = [
      event('2', 'assistant_message', { text: '답변' }),
      event('3', 'complete', { usage: { input_tokens: 10, output_tokens: 2 }, turn_cost_usd: 0.4 }),
      event('40', 'turn_summary', { content: '턴 요약 본문', final_response_event_id: 2, parent_event_id: 2 }),
    ];

    const items = project(events, 'hidden');

    expect(items.map((item) => item.key)).toEqual(['evt-2', 'evt-3']);
    expect(turnEndItems(items)).toEqual([
      expect.objectContaining({ key: 'evt-3', summaries: [expect.objectContaining({ content: '턴 요약 본문' })] }),
    ]);
  });

  test('drops empty assigned-card snapshots only from manuscript and keeps cards with content', () => {
    const snapshotEvent = (id: string, cards: unknown[]) => event(id, 'debug', {
      kind: 'assigned_card_context_snapshot',
      content: 'prepared input snapshot',
      capture: {
        source: 'prepared_model_input', identityMissing: false,
        registrationId: 'registration', executionCommandId: 'execution', inputId: `input-${id}`,
        snapshot: { cards },
      },
    });
    const empty = snapshotEvent('10', []);
    const card = snapshotEvent('20', [{ title: '작업 카드', status: 'running', latestReportAt: null }]);
    const emptyEvents = [event('1', 'user_message', { text: '질문', input_id: 'input-10' }), empty];
    const cardEvents = [event('2', 'user_message', { text: '질문', input_id: 'input-20' }), card];

    const emptyManuscript = project(emptyEvents);
    const cardManuscript = project(cardEvents);
    const emptyDefault = groupChatEvents(emptyEvents);

    expect(emptyManuscript.some((item) => JSON.stringify(item).includes('담당 카드 없음'))).toBe(false);
    expect(cardManuscript.some((item) => item.kind === 'turn-summary' && item.content.includes('작업 카드'))).toBe(true);
    expect(emptyDefault.some((item) => item.kind === 'turn-summary' && item.content === '담당 카드 없음')).toBe(true);
  });

  test('manuscript projection leaves the default render-item shape unchanged', () => {
    const events = [
      event('40', 'context_usage', { used_tokens: 63, max_tokens: 100, percent: 63 }),
      event('41', 'complete', { usage: { input_tokens: 10, output_tokens: 2 }, turn_cost_usd: 1.4 }),
    ];
    const base = {
      events,
      pendingOptimistic: undefined,
      streamingSlots: undefined,
      sessionStatus: 'completed',
    };
    const defaultHook = renderHook(() => useChatRenderItems({ ...base, presentation: 'default' }));
    const manuscriptHook = renderHook(() => useChatRenderItems({ ...base, presentation: 'manuscript' }));

    expect(defaultHook.result.current.reversedItems).toEqual(groupChatEvents(events).reverse());
    expect(defaultHook.result.current.reversedItems.map((item) => item.kind)).toEqual(['event', 'event']);
    expect(manuscriptHook.result.current.reversedItems.map((item) => item.kind)).toEqual(['turn-end-captions']);
    expect(manuscriptHook.result.current.reversedItems[0].key).toBe('evt-41');
  });

  test('a late turn summary joins the existing completion row', () => {
    const initialEvents = [
      event('1', 'user_message', { text: '질문' }),
      event('2', 'assistant_message', { text: '답변' }),
      event('3', 'complete', { usage: { input_tokens: 10, output_tokens: 2 }, turn_cost_usd: 0.4 }),
    ];
    const base = {
      pendingOptimistic: undefined,
      streamingSlots: undefined,
      sessionStatus: 'completed',
      presentation: 'manuscript' as const,
    };
    let events = initialEvents;
    const hook = renderHook(() => useChatRenderItems({ ...base, events }));
    const initialRow = hook.result.current.reversedItems.find((item) => item.kind === 'turn-end-captions');
    expect(initialRow?.key).toBe('evt-3');

    events = [
      ...initialEvents,
      event('40', 'turn_summary', {
        content: '늦게 도착한 요약', final_response_event_id: 2, parent_event_id: 2,
      }),
    ];
    hook.rerender({});

    const rows = hook.result.current.reversedItems.filter((item) => item.kind === 'turn-end-captions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'evt-3',
      summaries: [expect.objectContaining({ content: '늦게 도착한 요약' })],
    });
  });
});
