import { renderHook } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { chatUiFixtureEvent } from '../../../component-review/chat-ui-fixtures';
import { useChatRenderItems } from '../useChatRenderItems';

const event = (id: string, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent => ({
  id,
  type,
  data,
});

function outputRows(items: ReturnType<typeof useChatRenderItems>['reversedItems']) {
  return items.filter((item) => item.kind === 'event'
    && item.event.type === 'assistant_message'
    && item.event.data.attachment_output === true);
}

test.each(['default', 'manuscript'] as const)('%s keeps one linked output row when usage captions are hidden', (presentation) => {
  const user = event('40', 'user_message', { content: '첨부 부탁해' });
  const rich = { ...chatUiFixtureEvent('normal'), id: '41', data: {
    ...chatUiFixtureEvent('normal').data,
    content: '최종 답변',
    output_command_id: 'execute:attachment',
  } } as SessionEvent;
  const marker = event('42', 'assistant_message', {
    content: '', attachment_ids: ['image-one', 'file-one'],
    attachment_output: true, output_command_id: 'execute:attachment',
  });
  const complete = event('43', 'complete', {
    attachment_ids: ['image-one', 'file-one'], output_command_id: 'execute:attachment',
  });
  const events = [user, marker, rich, complete];
  const { result } = renderHook(() => useChatRenderItems({
    events,
    pendingOptimistic: undefined,
    streamingSlots: undefined,
    sessionStatus: 'completed',
    presentation,
    turnUsageMode: 'hidden',
  }));
  const chronological = [...result.current.reversedItems].reverse();
  const rows = outputRows(chronological);

  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    event: { id: '42', data: { attachment_ids: ['image-one', 'file-one'] } },
  });
  const richIndex = chronological.findIndex((item) => item.kind === 'event' && item.event.id === '41');
  expect(chronological[richIndex + 1]).toBe(rows[0]);
  expect(chronological.some((item) => item.kind === 'event' && item.event.id === '43'))
    .toBe(presentation === 'default');
});

test('prepend history retains the same output row identity and does not add another row', () => {
  const assistant = event('51', 'assistant_message', {
    content: '응답', output_command_id: 'execute:page',
  });
  const marker = event('52', 'assistant_message', {
    content: '', attachment_ids: ['page-file'], attachment_output: true,
    output_command_id: 'execute:page',
  });
  const complete = event('53', 'complete', { output_command_id: 'execute:page' });
  const { result, rerender } = renderHook(
    ({ events }: { events: SessionEvent[] }) => useChatRenderItems({
      events, pendingOptimistic: undefined, streamingSlots: undefined, sessionStatus: 'completed',
    }),
    { initialProps: { events: [marker, assistant, complete] } },
  );

  const initialRows = outputRows(result.current.reversedItems);
  expect(initialRows).toHaveLength(1);
  const initialKey = initialRows[0].key;
  rerender({ events: [event('49', 'user_message', { content: '이전 페이지' }), marker, assistant, complete] });

  const nextRows = outputRows(result.current.reversedItems);
  expect(nextRows).toHaveLength(1);
  expect(nextRows[0].key).toBe(initialKey);
  const chronological = [...result.current.reversedItems].reverse();
  const assistantIndex = chronological.findIndex((item) => item.kind === 'event' && item.event.id === '51');
  expect(chronological[assistantIndex + 1]).toBe(nextRows[0]);
});
