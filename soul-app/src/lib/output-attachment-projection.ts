import type { SessionEvent } from '../api/types';
import type { ChatRenderItem } from '../components/chat/groupChatEvents';

type EventRenderItem = Extract<ChatRenderItem, { kind: 'event' }>;

interface OutputSource {
  event: SessionEvent;
  outputCommandId: string;
  attachmentIds: string[];
  sourceIndex: number;
  isMarker: boolean;
}

/** Places durable output attachment events below the final assistant response in their command. */
export function projectOutputAttachments(
  items: readonly ChatRenderItem[],
  events: readonly SessionEvent[],
): ChatRenderItem[] {
  const sources = collectOutputSources(events);
  if (sources.length === 0) return [...items];

  const eventItemIndexes = new Map<string, number[]>();
  items.forEach((item, index) => {
    if (item.kind !== 'event') return;
    const indexes = eventItemIndexes.get(item.event.id) ?? [];
    indexes.push(index);
    eventItemIndexes.set(item.event.id, indexes);
  });

  const rowsAtPosition = new Map<number, EventRenderItem[]>();
  const skippedIndexes = new Set<number>();
  for (const source of sources) {
    const sourceIndexes = eventItemIndexes.get(source.event.id) ?? [];
    if (source.isMarker) sourceIndexes.forEach((index) => skippedIndexes.add(index));

    const anchor = findFinalAssistant(source, events);
    const anchorIndex = anchor ? eventItemIndexes.get(anchor.id)?.[0] : undefined;
    const sourceIndex = sourceIndexes[0];
    const position = anchorIndex !== undefined ? anchorIndex + 1 : sourceIndex;
    if (position === undefined) continue;

    const indexes = rowsAtPosition.get(position) ?? [];
    indexes.push(makeOutputRow(source));
    rowsAtPosition.set(position, indexes);
  }

  const projected: ChatRenderItem[] = [];
  for (let index = 0; index <= items.length; index += 1) {
    projected.push(...(rowsAtPosition.get(index) ?? []));
    if (index < items.length && !skippedIndexes.has(index)) projected.push(items[index]);
  }
  return projected;
}

function collectOutputSources(events: readonly SessionEvent[]): OutputSource[] {
  const markers = events.flatMap((event, sourceIndex): OutputSource[] => {
    if (event.type !== 'assistant_message' || event.data.attachment_output !== true) return [];
    const outputCommandId = stringValue(event.data.output_command_id);
    const attachmentIds = stringValues(event.data.attachment_ids);
    return outputCommandId && attachmentIds.length > 0
      ? [{ event, outputCommandId, attachmentIds, sourceIndex, isMarker: true }]
      : [];
  });
  const markerCommands = new Set(markers.map((marker) => marker.outputCommandId));
  const seenSources = new Set<string>();
  const sources = markers.filter((marker) => {
    const key = `${marker.outputCommandId}:${marker.event.id}`;
    if (seenSources.has(key)) return false;
    seenSources.add(key);
    return true;
  });

  events.forEach((event, sourceIndex) => {
    if (event.type !== 'complete') return;
    const outputCommandId = stringValue(event.data.output_command_id);
    const attachmentIds = stringValues(event.data.attachment_ids);
    if (!outputCommandId || attachmentIds.length === 0 || markerCommands.has(outputCommandId)) return;
    const key = `${outputCommandId}:${event.id}`;
    if (seenSources.has(key)) return;
    seenSources.add(key);
    sources.push({ event, outputCommandId, attachmentIds, sourceIndex, isMarker: false });
  });

  return sources.sort((a, b) => a.sourceIndex - b.sourceIndex);
}

function findFinalAssistant(source: OutputSource, events: readonly SessionEvent[]): SessionEvent | null {
  const terminalIndex = events.findIndex((event) => event.type === 'complete'
    && stringValue(event.data.output_command_id) === source.outputCommandId);
  const candidates = events.filter((event, index) => event.type === 'assistant_message'
    && event.data.attachment_output !== true
    && stringValue(event.data.output_command_id) === source.outputCommandId
    && (terminalIndex < 0 || index < terminalIndex));
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function makeOutputRow(source: OutputSource): EventRenderItem {
  const event: SessionEvent = source.isMarker
    ? source.event
    : {
      id: source.event.id,
      type: 'assistant_message',
      data: {
        content: '',
        attachment_ids: source.attachmentIds,
        attachment_output: true,
        output_command_id: source.outputCommandId,
      },
    };
  return {
    kind: 'event',
    event,
    key: `output-attachments:${source.outputCommandId}:${source.event.id}`,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}
