import { renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { useChatRenderItems } from '../useChatRenderItems';

const ev = (id: string, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent => ({
  id,
  type,
  data,
});

describe('useChatRenderItems manuscript activity', () => {
  it('원고형에서 저장 도구 호출과 스트리밍 생각 행을 함께 접고 바닥 추적 키도 접힌 행을 가리킨다', () => {
    const toolStart = ev('1', 'tool_start', { tool_use_id: 'tool-1', tool_name: 'Read' });
    const toolResult = ev('2', 'tool_result', { tool_use_id: 'tool-1', result: 'done' });
    const thinking = ev('stream-thinking', 'thinking_delta', { thinking: '검토 중' });
    const { result } = renderHook(() => useChatRenderItems({
      events: [toolStart, toolResult],
      pendingOptimistic: undefined,
      streamingSlots: { thinking },
      sessionStatus: 'running',
      presentation: 'manuscript',
    }));

    const activity = result.current.reversedItems.find((item) => item.kind === 'activity');
    expect(activity).toMatchObject({
      kind: 'activity',
      key: 'activity-tool-1',
      items: [
        { kind: 'tool', start: toolStart, result: toolResult },
        { kind: 'event', event: thinking },
      ],
    });
    expect(result.current.bottomFollowItemKey).toBe('activity-tool-1');
  });

  it('일반 채팅에서는 이벤트와 도구 행을 따로 유지한다', () => {
    const toolStart = ev('1', 'tool_start', { tool_use_id: 'tool-1' });
    const toolResult = ev('2', 'tool_result', { tool_use_id: 'tool-1' });
    const thinking = ev('stream-thinking', 'thinking_delta', { thinking: '검토 중' });
    const { result } = renderHook(() => useChatRenderItems({
      events: [toolStart, toolResult],
      pendingOptimistic: undefined,
      streamingSlots: { thinking },
      sessionStatus: 'running',
      presentation: 'default',
    }));

    expect(result.current.reversedItems.map((item) => item.kind)).toEqual(['typing', 'event', 'tool']);
    expect(result.current.bottomFollowItemKey).toBe('stream-thinking');
  });

  it('원고형에서만 알림과 위임 보고를 숨기고 optimistic 사용자 입력·assistant 응답은 유지한다', () => {
    const notification = ev('notice', 'session_notification', {
      delivery_intent: 'runtime_followup',
      disposition: 'queued',
      source: 'future_runtime_producer',
    });
    const agentReport = ev('agent-report', 'user_message', {
      text: '위임 보고',
      caller_info: { source: 'agent' },
    });
    const attachments = ['/image.png'];
    const person = ev('person', 'user_message', {
      text: '사람 입력',
      caller_info: { source: 'soul-app' },
      attachments,
    });
    const assistant = ev('assistant', 'assistant_message', { text: '답변' });
    const optimistic = ev('optimistic', 'intervention_sent', {
      text: '보내는 중',
      caller_info: { source: 'soul-app' },
    });
    const events = [notification, agentReport, person, assistant];
    const { result: manuscript } = renderHook(() => useChatRenderItems({
      events,
      pendingOptimistic: optimistic,
      streamingSlots: undefined,
      sessionStatus: 'completed',
      presentation: 'manuscript',
    }));
    const { result: standard } = renderHook(() => useChatRenderItems({
      events,
      pendingOptimistic: optimistic,
      streamingSlots: undefined,
      sessionStatus: 'completed',
      presentation: 'default',
    }));
    const eventRows = (items: typeof manuscript.current.reversedItems) => items
      .filter((item) => item.kind === 'event');
    const manuscriptRows = eventRows(manuscript.current.reversedItems);
    const manuscriptIds = manuscriptRows.map((item) => item.kind === 'event' ? item.event.id : item.key);
    const standardIds = eventRows(standard.current.reversedItems)
      .map((item) => item.kind === 'event' ? item.event.id : item.key);

    expect(manuscriptIds).toEqual(expect.arrayContaining(['person', 'assistant', 'optimistic']));
    expect(manuscriptIds).not.toContain('notice');
    expect(manuscriptIds).not.toContain('agent-report');
    expect(standardIds).toEqual(expect.arrayContaining([
      'notice', 'agent-report', 'person', 'assistant', 'optimistic',
    ]));
    const optimisticRow = manuscriptRows.find(
      (item) => item.kind === 'event' && item.event.id === 'optimistic',
    );
    expect(optimisticRow).toMatchObject({ kind: 'event', key: 'evt-optimistic' });
    if (optimisticRow?.kind === 'event') expect(optimisticRow.event).toBe(optimistic);
    const personRow = manuscriptRows.find(
      (item) => item.kind === 'event' && item.event.id === 'person',
    );
    if (personRow?.kind === 'event') {
      expect(personRow.event).toBe(person);
      expect(personRow.event.data.attachments).toBe(attachments);
    }
  });
});
