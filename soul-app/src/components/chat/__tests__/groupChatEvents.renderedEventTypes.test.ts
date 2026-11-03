import type { SessionEvent } from '../../../api/types';
import { groupChatEvents } from '../groupChatEvents';
import { RENDERED_EVENT_TYPES } from '../../events/eventRowTypes';

const event = (id: string, type: string): SessionEvent => ({
  id,
  type,
  data: {},
} as SessionEvent);

describe('RENDERED_EVENT_TYPES', () => {
  it('matches the event rows rendered by ChatEventList', () => {
    expect(RENDERED_EVENT_TYPES).toEqual(new Set([
      'user_message',
      'intervention_sent',
      'assistant_message',
      'text_delta',
      'realtime_transcript',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'complete',
      'context_usage',
      'compact',
      'session_notification',
      'input_request',
      'tool_approval_requested',
      'system',
      'realtime_status',
      'guardrail_tripwire',
      'error',
      'generation_started',
      'report_timeline',
    ]));
  });

  it('omits events without a chat row and keeps complete and context usage for projection', () => {
    const rows = groupChatEvents([
      event('1', 'session_ended'),
      event('2', 'session_start'),
      event('3', 'agent_updated'),
      event('4', 'unknown_future_event'),
      event('5', 'complete'),
      event('6', 'context_usage'),
    ]);

    expect(rows.map((item) => item.kind === 'event' ? item.event.type : item.kind))
      .toEqual(['complete', 'context_usage']);
  });

  it('keeps every event type rendered by the chat list', () => {
    const events = [...RENDERED_EVENT_TYPES].map((type, index) => event(String(index + 1), type));
    const rows = groupChatEvents(events, undefined, {
      showGenerationSeparator: true,
      showJevCandidates: false,
    });

    expect(rows.filter((item) => item.kind === 'event').map((item) => item.event.type))
      .toEqual([...RENDERED_EVENT_TYPES]);
  });
});
