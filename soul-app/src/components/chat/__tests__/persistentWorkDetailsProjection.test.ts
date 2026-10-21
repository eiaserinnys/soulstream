import type { SessionEvent } from '../../../api/types';
import type { ChatRenderItem, TurnSummaryRenderItem } from '../groupChatEvents';
import { projectPersistentWorkDetails } from '../persistentWorkDetailsProjection';

const completeEvent = { id: '10', type: 'complete', data: {} } as unknown as SessionEvent;
const summary: TurnSummaryRenderItem = {
  kind: 'turn-summary',
  event: completeEvent,
  content: '턴 요약',
  anchorEventId: 10,
  key: 'summary-10',
};
const usage = { title: '컨텍스트 12%', lines: ['정가 $0.01'] };

test('활동 줄과 요약 줄을 숨긴다', () => {
  const items: ChatRenderItem[] = [
    { kind: 'activity', items: [], key: 'activity-1' },
    summary,
  ];
  expect(projectPersistentWorkDetails(items)).toEqual([]);
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
    { kind: 'event', event: completeEvent, key: 'event-1' },
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
