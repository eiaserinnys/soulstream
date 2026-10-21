import type { SessionEvent } from '../../../api/types';
import type { ChatRenderItem, TurnSummaryRenderItem } from '../groupChatEvents';
import { projectPersistentWorkDetails } from '../persistentWorkDetailsProjection';

const completeEvent = { id: '10', type: 'complete', data: {} } as unknown as SessionEvent;
const turnSummaryEvent = { id: '10', type: 'turn_summary', data: {} } as unknown as SessionEvent;
const summary: TurnSummaryRenderItem = {
  kind: 'turn-summary',
  event: turnSummaryEvent,
  content: '턴 요약',
  anchorEventId: 10,
  key: 'summary-10',
};
const assignedCardChip: TurnSummaryRenderItem = {
  kind: 'turn-summary',
  event: { id: '11', type: 'debug', data: { kind: 'assigned_card_context_snapshot' } } as unknown as SessionEvent,
  content: '담당 카드 현황',
  anchorEventId: 11,
  key: 'turn-summary-11',
};
const assistantMessage: ChatRenderItem = {
  kind: 'event',
  event: { id: '12', type: 'assistant_message', data: { text: '응답' } } as unknown as SessionEvent,
  key: 'assistant-12',
};
const activity: ChatRenderItem = { kind: 'activity', items: [], key: 'activity-13' };
const usage = { title: '컨텍스트 12%', lines: ['정가 $0.01'] };

test('활동 줄과 실제 요약 줄을 숨긴다', () => {
  const items: ChatRenderItem[] = [
    { kind: 'activity', items: [], key: 'activity-1' },
    summary,
  ];
  expect(projectPersistentWorkDetails(items)).toEqual([]);
});

test('활동 앞 응답에는 원고형 서술 표식을 붙인다', () => {
  expect(projectPersistentWorkDetails([assistantMessage, activity])).toEqual([
    { ...assistantMessage, manuscriptNarration: true },
  ]);
});

test('담당 카드 칩은 요약 배열 안에 있어도 남긴다', () => {
  const items: ChatRenderItem[] = [
    assignedCardChip,
    { kind: 'event', event: completeEvent, key: 'event-2', summaries: [assignedCardChip] },
  ];
  expect(projectPersistentWorkDetails(items)).toEqual([
    assignedCardChip,
    { kind: 'event', event: completeEvent, key: 'event-2', summaries: [assignedCardChip] },
  ]);
});

test('이벤트와 도구 항목의 summaries만 제거하고 항목은 남긴다', () => {
  const eventItem: ChatRenderItem = { kind: 'event', event: completeEvent, key: 'event-1', summaries: [summary] };
  const toolItem: ChatRenderItem = {
    kind: 'tool',
    start: { id: '11', type: 'tool_start', data: {} } as unknown as SessionEvent,
    key: 'tool-1',
    summaries: [summary],
  };
  expect(projectPersistentWorkDetails([eventItem, toolItem])).toEqual([
    { kind: 'event', event: completeEvent, key: 'event-1', summaries: undefined },
    expect.objectContaining({ kind: 'tool', key: 'tool-1', summaries: undefined }),
  ]);
});

test('보여 줄 것이 없어진 턴 끝 캡션 항목은 뺀다', () => {
  const items: ChatRenderItem[] = [
    { kind: 'turn-end-captions', event: completeEvent, key: 'captions-1', summaries: [summary] },
  ];
  expect(projectPersistentWorkDetails(items)).toEqual([]);
});

test('사용량이 있는 턴 끝 캡션은 남기고 요약만 지운다', () => {
  const items: ChatRenderItem[] = [
    { kind: 'turn-end-captions', event: completeEvent, key: 'captions-2', usage, summaries: [summary] },
  ];
  expect(projectPersistentWorkDetails(items)).toEqual([
    { kind: 'turn-end-captions', event: completeEvent, key: 'captions-2', usage },
  ]);
});

test('지속 지시 기록 캡션은 남기고 요약만 지운다', () => {
  const persistentInstructionRecorded = {
    instructions: [{ id: 'instruction-1', text: '항상 한국어로', source_turns: ['1'] }],
    capReached: false,
  };
  const items: ChatRenderItem[] = [
    {
      kind: 'turn-end-captions',
      event: completeEvent,
      key: 'captions-3',
      summaries: [summary],
      persistentInstructionRecorded,
    },
  ];
  expect(projectPersistentWorkDetails(items)).toEqual([
    {
      kind: 'turn-end-captions',
      event: completeEvent,
      key: 'captions-3',
      persistentInstructionRecorded,
    },
  ]);
});

test('서술 표식을 붙여도 그 응답에서 걷어낸 요약은 되살아나지 않는다', () => {
  const narrationWithSummary: ChatRenderItem = {
    ...(assistantMessage as Extract<ChatRenderItem, { kind: 'event' }>),
    summaries: [summary],
  };
  const projected = projectPersistentWorkDetails([narrationWithSummary, activity]);
  expect(projected).toHaveLength(1);
  const [first] = projected as Array<Extract<ChatRenderItem, { kind: 'event' }>>;
  expect(first.manuscriptNarration).toBe(true);
  expect(first.summaries).toBeUndefined();
});
