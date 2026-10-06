import { renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { groupChatEvents } from '../groupChatEvents';
import { projectPersistentTurnUsage } from '../persistentTurnUsageProjection';
import { useChatRenderItems } from '../useChatRenderItems';

function event(id: string, type: string, data: Record<string, unknown> = {}): SessionEvent {
  return { id, type: type as SessionEvent['type'], data };
}

function project(events: SessionEvent[], showTurnUsage = true) {
  return projectPersistentTurnUsage(groupChatEvents(events), events, showTurnUsage);
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
    const usageItems = items.filter((item) => item.kind === 'turn-usage');

    expect(usageItems.map((item) => item.key)).toEqual(['evt-11', 'evt-14']);
    expect(usageItems.map((item) => item.title)).toEqual([
      '컨텍스트 약 63.0% · 정가 $0.62',
      '컨텍스트 22.0% · 정가 $0.05',
    ]);
    expect(usageItems[0]).toMatchObject({
      expandedTitle: '컨텍스트 약 630,000 / 1,000,000 (63.0%)',
      lines: [
        '턴 완료 · 입력 645,367 (캐시 645,361) · 출력 6,139 · 정가 $0.62 (세션 $17.91)',
      ],
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

    expect(items.some((item) => item.kind === 'turn-usage')).toBe(false);
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
    expect(items.some((item) => item.kind === 'turn-usage')).toBe(false);
    expect(items.some((item) => item.kind === 'event' && item.event.id === '22')).toBe(false);
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

    const items = project(events, false);

    expect(items.map((item) => item.key)).toEqual(['evt-30', 'evt-33']);
    expect(items.find((item) => item.key === 'evt-33')).toMatchObject({
      kind: 'event', event: errorEvent,
    });
    expect(items.some((item) => item.kind === 'turn-usage')).toBe(false);
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
    expect(manuscriptHook.result.current.reversedItems.map((item) => item.kind)).toEqual(['turn-usage']);
    expect(manuscriptHook.result.current.reversedItems[0].key).toBe('evt-41');
  });
});
