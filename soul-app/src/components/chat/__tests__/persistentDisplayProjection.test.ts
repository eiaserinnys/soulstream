import { renderHook } from '@testing-library/react-native';
import { groupChatEvents } from '../groupChatEvents';
import type { SessionEvent } from '../../../api/types';
import { persistentJevCandidatesFixture } from '../../../component-review/persistentJevCandidatesFixture';
import { persistentChatEvents } from '../../../component-review/ReviewChat';
import { useChatRenderItems } from '../useChatRenderItems';

const enabled = {
  showGenerationSeparator: true,
  showJevCandidates: true,
};

function userEvent(id: string): SessionEvent {
  return {
    id,
    type: 'user_message',
    data: { input_id: `input-${id}`, text: '질문' },
  };
}

function candidatesEvent(id: string, inputId: string): SessionEvent {
  return persistentJevCandidatesFixture(id, inputId, { selectedCount: 2 });
}

function jevItems(events: SessionEvent[], settings = enabled) {
  return groupChatEvents(events, undefined, settings).filter(item => item.kind === 'jev-candidates');
}

test('raw Jev debug is projected directly below its input with only display text', () => {
  const input = userEvent('10');
  const debug = candidatesEvent('11', 'input-10');
  const items = groupChatEvents([input, debug], undefined, enabled);

  expect(items.map(item => item.kind)).toEqual(['event', 'jev-candidates']);
  expect(items[1]).toMatchObject({
    kind: 'jev-candidates',
    title: 'Jev 후보 2',
    lines: ['T38 · 요약 한 줄 · 3/3', '#412 · 카드 한 줄 · 2/3'],
  });
  expect(JSON.stringify(items[1])).not.toContain('fixture-session');
  expect(JSON.stringify(items[1])).not.toContain('fixture-card-id');
  expect(JSON.stringify(items[1])).not.toContain('jev-latest');
  expect(JSON.stringify(items[1])).not.toContain('candidate_counts');
});

test('new, extended, and legacy Jev observations keep the same rendered rows', () => {
  const selectedExpected = {
    title: 'Jev 후보 2',
    lines: ['T38 · 요약 한 줄 · 3/3', '#412 · 카드 한 줄 · 2/3'],
  };
  const events = [
    persistentJevCandidatesFixture('62', 'input-60', { selectedCount: 2 }),
    persistentJevCandidatesFixture('64', 'input-61', { selectedCount: 2, includeUnknownField: true }),
    persistentJevCandidatesFixture('66', 'input-62', { selectedCount: 2, includeNewFields: false }),
  ];
  const inputs = [userEvent('60'), userEvent('61'), userEvent('62')];
  const items = groupChatEvents(events.flatMap((event, index) => [inputs[index]!, event]), undefined, enabled)
    .filter(item => item.kind === 'jev-candidates');

  expect(items).toHaveLength(3);
  for (const item of items) expect(item).toMatchObject(selectedExpected);
});

test('ReviewChat candidate fixtures project empty and long candidate observations', () => {
  const emptyInput = userEvent('20');
  const longInput = userEvent('21');
  const items = groupChatEvents([
    emptyInput,
    persistentJevCandidatesFixture('22', 'input-20', { selectedCount: 0 }),
    longInput,
    persistentJevCandidatesFixture('23', 'input-21', { selectedCount: 1, longLine: true }),
  ], undefined, enabled).filter(item => item.kind === 'jev-candidates');

  expect(items).toMatchObject([
    { title: 'Jev 후보 0', lines: ['2점 이상인 후보가 없습니다.'] },
    { title: 'Jev 후보 1', lines: ['T38 · 이 후보의 긴 요약은 좁은 화면과 넓은 화면에서 한 줄 말줄임 처리가 적용되는지 실제 캡션에서 확인하기 위해 일부러 길게 작성한 문장입니다. 후보 내용이 길어져도 줄바꿈 대신 오른쪽 끝에서 말줄임 표시가 유지되는지 볼 수 있도록 충분히 긴 문장을 넣었습니다. · 3/3'] },
  ]);
});

test('keeps an early Jev record until its input arrives and does not move it to the last turn', () => {
  const debug = candidatesEvent('21', 'input-20');
  const laterInput = userEvent('30');
  expect(jevItems([debug, laterInput])).toHaveLength(0);

  const input = userEvent('20');
  const items = groupChatEvents([debug, laterInput, input], undefined, enabled);
  const jevIndex = items.findIndex(item => item.kind === 'jev-candidates');
  expect(items[jevIndex - 1]).toMatchObject({ kind: 'event', event: { id: '20' } });
});

test('keeps candidate records independent for the same input and hides them only in projection', () => {
  const input = userEvent('40');
  const debug = candidatesEvent('41', 'input-40');
  const hidden = groupChatEvents([input, debug], undefined, {
    showGenerationSeparator: false,
    showJevCandidates: false,
  });
  expect(hidden.map(item => item.kind)).toEqual(['event']);

  const shownAgain = groupChatEvents([input, debug], undefined, enabled);
  expect(shownAgain.map(item => item.kind)).toEqual(['event', 'jev-candidates']);
});

test('places generation dividers in event order and omits them without leaving phantom rows', () => {
  const events: SessionEvent[] = [
    { id: '50', type: 'assistant_message', data: { text: '이전 답변' } },
    { id: '51', type: 'generation_started', data: { generation: 2 } },
    { id: '52', type: 'assistant_message', data: { text: '다음 답변' } },
  ];
  expect(groupChatEvents(events, undefined, enabled).map(item => item.kind === 'event' ? item.event.type : item.kind))
    .toEqual(['assistant_message', 'generation_started', 'assistant_message']);
  expect(groupChatEvents(events, undefined, { ...enabled, showGenerationSeparator: false }))
    .toHaveLength(2);
});

test('ReviewChat raw delivery fixtures remain visible by default and are filtered only in manuscript', () => {
  const renderItems = (presentation: 'default' | 'manuscript') => useChatRenderItems({
    events: persistentChatEvents,
    pendingOptimistic: undefined,
    streamingSlots: undefined,
    sessionStatus: 'completed',
    presentation,
  });
  const defaultResult = renderHook(() => renderItems('default'));
  const manuscriptResult = renderHook(() => renderItems('manuscript'));
  const defaultRows = [...defaultResult.result.current.reversedItems].reverse()
    .filter(item => item.kind === 'event');
  const manuscriptRows = [...manuscriptResult.result.current.reversedItems].reverse()
    .filter(item => item.kind === 'event');
  const defaultById = new Map(defaultRows.map(item => [item.event.id, item.event]));
  const manuscriptById = new Map(manuscriptRows.map(item => [item.event.id, item.event]));

  expect(defaultById.get('930')).toMatchObject({
    type: 'session_notification',
    data: { delivery_intent: 'completion_notification', disposition: 'queued' },
  });
  expect(defaultById.get('931')).toMatchObject({
    type: 'session_notification',
    data: { delivery_intent: 'runtime_followup', disposition: 'auto_resume' },
  });
  expect(defaultById.get('932')?.data.caller_info).toMatchObject({ source: 'agent' });
  expect(defaultById.get('933')?.data).toMatchObject({
    caller_info: { source: 'browser' },
    attachments: [expect.any(String)],
  });
  expect(defaultById.get('934')?.data.text).toBe('PAS 응답: 첨부 이미지를 확인했습니다.');

  expect(manuscriptById.has('930')).toBe(false);
  expect(manuscriptById.has('931')).toBe(false);
  expect(manuscriptById.has('932')).toBe(false);
  expect(manuscriptById.get('933')).toBe(defaultById.get('933'));
  expect(manuscriptById.get('934')).toBe(defaultById.get('934'));
});
