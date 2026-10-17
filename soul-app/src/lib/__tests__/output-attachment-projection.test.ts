import type { SessionEvent } from '../../api/types';
import { groupChatEvents, type ChatRenderItem } from '../../components/chat/groupChatEvents';
import { projectOutputAttachments } from '../output-attachment-projection';

const event = (id: string, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent => ({
  id,
  type,
  data,
});

type EventRenderItem = Extract<ChatRenderItem, { kind: 'event' }>;

function outputRows(items: readonly ChatRenderItem[]): EventRenderItem[] {
  return items.filter((item): item is EventRenderItem => item.kind === 'event'
    && item.event.type === 'assistant_message'
    && item.event.data.attachment_output === true);
}

describe('projectOutputAttachments', () => {
  it('keeps complete IDs absent from the marker immediately before complete', () => {
    const events = [event('1', 'user_message'), event('2', 'assistant_message', { content: '답변', output_command_id: 'cmd' }),
      event('3', 'assistant_message', { attachment_output: true, attachment_ids: ['A'], output_command_id: 'cmd' }),
      event('4', 'complete', { attachment_ids: ['A', 'B', 'B'], output_command_id: 'cmd' })];
    const projected = projectOutputAttachments(groupChatEvents(events), events);
    expect(outputRows(projected).map(row => row.event.data.attachment_ids)).toEqual([['A'], ['B']]);
    const completeIndex = projected.findIndex(item => item.kind === 'event' && item.event.id === '4' && item.event.type === 'complete');
    expect(projected[completeIndex - 1]).toBe(outputRows(projected)[1]);
  });

  it('keeps unstamped complete attachments inside each legacy turn boundary', () => {
    const events = [event('1', 'user_message'), event('2', 'assistant_message', { content: '답변' }),
      event('3', 'complete', { attachment_ids: ['A'] }), event('4', 'user_message'),
      event('5', 'complete', { attachment_ids: ['A'] })];
    const rows = outputRows(projectOutputAttachments(groupChatEvents(events), events));
    expect(rows.map(row => [row.event.id, row.event.data.attachment_ids])).toEqual([['3', ['A']], ['5', ['A']]]);
  });
  it('moves a P6B output marker below its final assistant and deduplicates the complete copy', () => {
    const user = event('10', 'user_message', { content: '질문' });
    const firstAssistant = event('11', 'assistant_message', {
      content: '중간 답변', output_command_id: 'execute:one',
    });
    const richFinalAssistant = event('12', 'assistant_message', {
      content: '최종 답변', output_command_id: 'execute:one',
      ui: { schema_version: 1, ui_id: 'rich-one' },
    });
    const marker = event('13', 'assistant_message', {
      content: '', attachment_ids: ['image-one', 'file-one'],
      attachment_output: true, output_command_id: 'execute:one',
    });
    const complete = event('14', 'complete', {
      attachment_ids: ['image-one', 'file-one'], output_command_id: 'execute:one',
    });
    const events = [user, firstAssistant, marker, richFinalAssistant, complete];

    const projected = projectOutputAttachments(groupChatEvents(events), events);
    const rows = outputRows(projected);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'event',
      event: { id: '13', type: 'assistant_message', data: {
        content: '', attachment_ids: ['image-one', 'file-one'],
        attachment_output: true, output_command_id: 'execute:one',
      } },
    });
    const chronological = projected.filter((item) => item.kind === 'event');
    const finalIndex = chronological.findIndex((item) => item.kind === 'event' && item.event.id === '12');
    expect(chronological[finalIndex + 1]).toBe(rows[0]);
    expect(chronological.filter((item) => item.kind === 'event' && item.event.id === '13')).toHaveLength(1);
    expect(chronological.some((item) => item.kind === 'event' && item.event.id === '14')).toBe(true);
    const finalAssistant = chronological.find((item) => item.kind === 'event' && item.event.id === '12');
    expect(finalAssistant?.kind === 'event' ? finalAssistant.event.data.ui : undefined)
      .toEqual({ schema_version: 1, ui_id: 'rich-one' });
  });

  it('derives a legacy complete-only output under its matching assistant before the next turn', () => {
    const answer = event('21', 'assistant_message', {
      content: '옛 답변', output_command_id: 'execute:old',
    });
    const complete = event('22', 'complete', {
      attachment_ids: ['legacy-file'], output_command_id: 'execute:old',
    });
    const nextUser = event('23', 'user_message', { content: '다음 질문' });
    const nextAnswer = event('24', 'assistant_message', {
      content: '다음 답변', output_command_id: 'execute:new',
    });
    const events = [answer, complete, nextUser, nextAnswer];

    const projected = projectOutputAttachments(groupChatEvents(events), events);
    const rows = outputRows(projected);
    const chronological = projected.filter((item) => item.kind === 'event');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: { id: '22', data: {
        attachment_ids: ['legacy-file'], attachment_output: true, output_command_id: 'execute:old',
      } },
    });
    const answerIndex = chronological.findIndex((item) => item.kind === 'event' && item.event.id === '21');
    const outputIndex = chronological.indexOf(rows[0]);
    const nextUserIndex = chronological.findIndex((item) => item.kind === 'event' && item.event.id === '23');
    expect(outputIndex).toBe(answerIndex + 1);
    expect(outputIndex).toBeLessThan(nextUserIndex);
  });

  it('keeps legacy complete IDs at the turn boundary without inventing registration failures', () => {
    const assistant = event('31', 'assistant_message', { content: '답변' });
    const complete = event('32', 'complete', { attachment_ids: ['unlinked-file'] });
    const registeredAnswer = event('33', 'assistant_message', {
      content: '두 번째 답변', output_command_id: 'execute:unregistered',
    });
    const registrationFailed = event('34', 'complete', { output_command_id: 'execute:unregistered' });
    const events = [assistant, complete, registeredAnswer, registrationFailed];

    const rows = outputRows(projectOutputAttachments(groupChatEvents(events), events));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: { id: '32', data: { attachment_ids: ['unlinked-file'] } } });
  });
});
