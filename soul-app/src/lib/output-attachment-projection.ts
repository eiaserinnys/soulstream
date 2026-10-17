import type { SessionEvent } from '../api/types';
import type { ChatRenderItem } from '../components/chat/groupChatEvents';

type EventRenderItem = Extract<ChatRenderItem, { kind: 'event' }>;
interface OutputSource {
  event: SessionEvent;
  outputCommandId: string | null;
  attachmentIds: string[];
  sourceIndex: number;
  turnStart: number;
  isMarker: boolean;
}

/** Marker rows follow their response; remaining complete IDs stay before complete. */
export function projectOutputAttachments(items: readonly ChatRenderItem[], events: readonly SessionEvent[]): ChatRenderItem[] {
  const sources = collectOutputSources(events);
  const indexes = new Map<string, number>();
  items.forEach((item, index) => { if (item.kind === 'event') indexes.set(item.event.id, index); });
  const rowsAtPosition = new Map<number, EventRenderItem[]>();
  for (const source of sources) {
    const anchor = source.isMarker ? findFinalAssistant(source, events) : null;
    const anchorIndex = anchor ? indexes.get(anchor.id) : undefined;
    const position = anchorIndex !== undefined ? anchorIndex + 1 : indexes.get(source.event.id);
    if (position === undefined) continue;
    const rows = rowsAtPosition.get(position) ?? [];
    rows.push(makeOutputRow(source));
    rowsAtPosition.set(position, rows);
  }
  const projected: ChatRenderItem[] = [];
  for (let index = 0; index <= items.length; index += 1) {
    projected.push(...(rowsAtPosition.get(index) ?? []));
    const item = items[index];
    if (item && !(item.kind === 'event' && item.event.type === 'assistant_message' && item.event.data.attachment_output === true)) {
      projected.push(item);
    }
  }
  return projected;
}

function collectOutputSources(events: readonly SessionEvent[]): OutputSource[] {
  const displayed = new Set<string>();
  const sources: OutputSource[] = [];
  let turnStart = 0;
  events.forEach((event, sourceIndex) => {
    if (event.type === 'generation_started' || event.type === 'user_message' || event.type === 'intervention_sent') {
      displayed.clear();
      turnStart = sourceIndex;
    }
    const isMarker = event.type === 'assistant_message' && event.data.attachment_output === true;
    if (isMarker || event.type === 'complete') {
      const ids = Array.isArray(event.data.attachment_ids) ? event.data.attachment_ids : [];
      const attachmentIds = ids.filter((id): id is string => {
        if (typeof id !== 'string' || !id || displayed.has(id)) return false;
        displayed.add(id);
        return true;
      });
      if (attachmentIds.length > 0) sources.push({ event, sourceIndex, turnStart, isMarker, attachmentIds,
        outputCommandId: typeof event.data.output_command_id === 'string' ? event.data.output_command_id : null });
    }
    if (event.type === 'complete') { displayed.clear(); turnStart = sourceIndex + 1; }
  });
  return sources;
}

function findFinalAssistant(source: OutputSource, events: readonly SessionEvent[]): SessionEvent | null {
  const end = events.findIndex((event, index) => index >= source.sourceIndex && event.type === 'complete');
  const candidates = events.slice(source.turnStart, end < 0 ? undefined : end).filter(event =>
    event.type === 'assistant_message' && event.data.attachment_output !== true
    && (source.outputCommandId === null || event.data.output_command_id === source.outputCommandId));
  return candidates[candidates.length - 1] ?? null;
}

function makeOutputRow(source: OutputSource): EventRenderItem {
  const event: SessionEvent = {
    ...source.event,
    type: 'assistant_message',
    data: { ...source.event.data, content: '', attachment_ids: source.attachmentIds, attachment_output: true },
  };
  return { kind: 'event', event, key: `output-attachments:${source.outputCommandId ?? 'legacy'}:${source.event.id}` };
}
