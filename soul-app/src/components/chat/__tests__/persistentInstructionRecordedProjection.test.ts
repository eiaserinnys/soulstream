import type { SessionEvent } from '../../../api/types';
import { groupChatEvents } from '../groupChatEvents';
import { projectPersistentTurnUsage } from '../persistentTurnUsageProjection';

const ev = (
  id: string,
  type: SessionEvent['type'],
  data: Record<string, unknown> = {},
): SessionEvent => ({ id, type, data });

const recorded = (inputId: string | undefined, instructions: unknown, capReached = false) =>
  ev('5', 'debug', {
    kind: 'persistent_instruction_recorded',
    instructions,
    cap_reached: capReached,
    ...(inputId ? { input_id: inputId } : {}),
    timestamp: 1_791_289_200,
  });

const instruction = {
  id: 'instruction-1',
  text: 'Keep decisions in the session note',
  source_turns: ['T195', 'T210'],
  action: 'updated',
};

describe('persistent instruction recorded turn-end projection', () => {
  it('anchors a server-shaped string-turn debug event after the matching turn summary', () => {
    const events = [
      ev('1', 'user_message', { input_id: 'input-1', text: 'Please remember this' }),
      ev('2', 'assistant_message', { text: 'I will remember it' }),
      ev('3', 'complete'),
      ev('4', 'turn_summary', {
        content: 'The instruction was recorded',
        final_response_event_id: 2,
        parent_event_id: 2,
      }),
      recorded('input-1', [instruction]),
    ];

    const items = groupChatEvents(events);
    expect(items.map((item) => item.kind)).toEqual([
      'event', 'event', 'event', 'turn-end-captions',
    ]);
    const assistant = items[1];
    expect(assistant.kind === 'event' && assistant.summaries?.[0]?.content)
      .toBe('The instruction was recorded');

    const caption = items[3];
    expect(caption.kind === 'turn-end-captions' ? caption.persistentInstructionRecorded : undefined)
      .toEqual({
        instructions: [{ id: 'instruction-1', text: instruction.text, source_turns: ['T195', 'T210'] }],
        capReached: false,
      });
  });

  it.each([
    ['missing input_id', recorded(undefined, [instruction])],
    ['unmatched input_id', recorded('missing', [instruction])],
    ['invalid numeric source turns', recorded('input-1', [{ ...instruction, source_turns: [195, 210] }])],
    ['other debug kind', ev('5', 'debug', { kind: 'persistent_decision', input_id: 'input-1' })],
  ])('does not display %s', (_name, debug) => {
    const items = groupChatEvents([
      ev('1', 'user_message', { input_id: 'input-1' }),
      ev('2', 'assistant_message', { text: 'answer' }),
      ev('3', 'complete'),
      debug,
    ]);

    expect(items.some((item) => item.kind === 'turn-end-captions')).toBe(false);
  });

  it('combines the instruction caption with usage and summary in the manuscript turn-end group', () => {
    const events = [
      ev('1', 'user_message', { input_id: 'input-1', text: 'Please remember this' }),
      ev('2', 'assistant_message', { text: 'I will remember it' }),
      ev('3', 'complete', { turn_cost_usd: 0.5 }),
      ev('4', 'turn_summary', {
        content: 'The instruction was recorded',
        final_response_event_id: 2,
        parent_event_id: 2,
      }),
      recorded('input-1', [instruction], true),
    ];

    const turnEnds = projectPersistentTurnUsage(groupChatEvents(events), events)
      .filter((item) => item.kind === 'turn-end-captions');

    expect(turnEnds).toHaveLength(1);
    const [caption] = turnEnds;
    expect(caption?.kind === 'turn-end-captions' ? {
      usage: caption.usage?.title,
      summaries: caption.summaries?.map((summary) => summary.content),
      persistentInstructionRecorded: caption.persistentInstructionRecorded,
    } : null).toEqual({
      usage: '정가 $0.50',
      summaries: ['The instruction was recorded'],
      persistentInstructionRecorded: {
        instructions: [{ id: 'instruction-1', text: instruction.text, source_turns: ['T195', 'T210'] }],
        capReached: true,
      },
    });
  });

  it('keeps a cap-only event as a turn-end caption', () => {
    const events = [
      ev('1', 'user_message', { input_id: 'input-1' }),
      ev('2', 'assistant_message', { text: 'The limit is full' }),
      ev('3', 'complete'),
      recorded('input-1', [], true),
    ];

    const turnEnds = projectPersistentTurnUsage(groupChatEvents(events), events)
      .filter((item) => item.kind === 'turn-end-captions');

    expect(turnEnds).toHaveLength(1);
    const caption = turnEnds[0];
    expect(caption?.kind === 'turn-end-captions' ? caption.persistentInstructionRecorded : undefined)
      .toEqual({ instructions: [], capReached: true });
  });

  it('keeps the recorded instruction and summary when usage is hidden', () => {
    const events = [
      ev('1', 'user_message', { input_id: 'input-1' }),
      ev('2', 'assistant_message', { text: 'I will remember it' }),
      ev('3', 'complete', { turn_cost_usd: 0.5 }),
      ev('4', 'turn_summary', {
        content: 'The instruction was recorded',
        final_response_event_id: 2,
        parent_event_id: 2,
      }),
      recorded('input-1', [instruction]),
    ];

    const turnEnds = projectPersistentTurnUsage(groupChatEvents(events), events, 'hidden' as never)
      .filter((item) => item.kind === 'turn-end-captions');

    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]).toMatchObject({
      key: 'evt-3',
      summaries: [expect.objectContaining({ content: 'The instruction was recorded' })],
      persistentInstructionRecorded: expect.objectContaining({ instructions: [expect.objectContaining({
        id: instruction.id,
        text: instruction.text,
        source_turns: instruction.source_turns,
      })] }),
    });
    expect(turnEnds[0]?.usage).toBeUndefined();
  });
});
