import { groupChatEvents } from '../groupChatEvents';
import type { SessionEvent } from '../../../api/types';
import { persistentJevCandidatesFixture } from '../../../component-review/persistentJevCandidatesFixture';

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
  return persistentJevCandidatesFixture(id, inputId, 2);
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
