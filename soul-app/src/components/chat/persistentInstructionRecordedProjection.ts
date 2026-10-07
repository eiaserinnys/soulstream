import type { SessionEvent } from '../../api/types';
import type {
  ChatRenderItem,
  PersistentInstructionRecordedCaption,
  TurnEndCaptionsRenderItem,
} from './groupChatEvents';

type ParsedRecordedEvent = {
  inputId: string;
  caption: PersistentInstructionRecordedCaption;
};

type CaptionAccumulator = {
  event: SessionEvent;
  instructions: Map<string, { id: string; text: string; source_turns: string[] }>;
  capReached: boolean;
};

const RECORDED_KIND = 'persistent_instruction_recorded';

function isInputEvent(event: SessionEvent): boolean {
  return event.type === 'user_message' || event.type === 'intervention_sent';
}

function parseRecordedEvent(event: SessionEvent): ParsedRecordedEvent | null {
  if (event.type !== 'debug' || event.data.kind !== RECORDED_KIND) return null;
  const inputId = event.data.input_id;
  const rawInstructions = event.data.instructions;
  const capReached = event.data.cap_reached;
  if (typeof inputId !== 'string' || inputId.length === 0) return null;
  if (!Array.isArray(rawInstructions) || typeof capReached !== 'boolean') return null;

  const instructions: PersistentInstructionRecordedCaption['instructions'] = [];
  for (const value of rawInstructions) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const instruction = value as Record<string, unknown>;
    const sourceTurns = instruction.source_turns;
    if (
      typeof instruction.id !== 'string'
      || instruction.id.length === 0
      || typeof instruction.text !== 'string'
      || instruction.text.length === 0
      || !Array.isArray(sourceTurns)
      || !sourceTurns.every((turn) => typeof turn === 'string' && /^T[0-9]+$/.test(turn))
      || (instruction.action !== 'added' && instruction.action !== 'updated')
    ) return null;

    instructions.push({
      id: instruction.id,
      text: instruction.text,
      source_turns: sourceTurns,
    });
  }
  if (instructions.length === 0 && !capReached) return null;

  return { inputId, caption: { instructions, capReached } };
}

function inputId(event: SessionEvent): string | null {
  const value = event.data.input_id;
  return isInputEvent(event) && typeof value === 'string' && value.length > 0
    ? value
    : null;
}

/** Place the recorded-instruction caption after the complete event for its anchored input. */
export function placePersistentInstructionRecordedCaptions(
  baseItems: ChatRenderItem[],
  events: SessionEvent[],
): ChatRenderItem[] {
  const inputIndexById = new Map<string, number>();
  events.forEach((event, index) => {
    const id = inputId(event);
    if (id !== null) inputIndexById.set(id, index);
  });

  const visibleInputIds = new Set<string>();
  const visibleCompleteIds = new Set<string>();
  for (const item of baseItems) {
    if (item.kind !== 'event') continue;
    const id = inputId(item.event);
    if (id !== null) visibleInputIds.add(id);
    if (item.event.type === 'complete') visibleCompleteIds.add(item.event.id);
  }

  const captionsByCompleteId = new Map<string, CaptionAccumulator>();
  for (const event of events) {
    const recorded = parseRecordedEvent(event);
    if (!recorded || !visibleInputIds.has(recorded.inputId)) continue;
    const anchorIndex = inputIndexById.get(recorded.inputId);
    if (anchorIndex === undefined) continue;

    let complete: SessionEvent | undefined;
    for (let index = anchorIndex + 1; index < events.length; index += 1) {
      const candidate = events[index];
      if (isInputEvent(candidate)) break;
      if (candidate.type === 'complete') {
        complete = candidate;
        break;
      }
    }
    if (!complete || !visibleCompleteIds.has(complete.id)) continue;

    const current = captionsByCompleteId.get(complete.id) ?? {
      event: complete,
      instructions: new Map(),
      capReached: false,
    };
    for (const instruction of recorded.caption.instructions) {
      current.instructions.set(instruction.id, instruction);
    }
    current.capReached ||= recorded.caption.capReached;
    captionsByCompleteId.set(complete.id, current);
  }

  if (captionsByCompleteId.size === 0) return baseItems;

  const out: ChatRenderItem[] = [];
  for (const item of baseItems) {
    out.push(item);
    if (item.kind !== 'event' || item.event.type !== 'complete') continue;
    const accumulated = captionsByCompleteId.get(item.event.id);
    if (!accumulated) continue;

    const caption: TurnEndCaptionsRenderItem = {
      kind: 'turn-end-captions',
      event: accumulated.event,
      key: `persistent-instruction-recorded-${item.event.id}`,
      persistentInstructionRecorded: {
        instructions: [...accumulated.instructions.values()],
        capReached: accumulated.capReached,
      },
    };
    out.push(caption);
  }

  return out;
}
