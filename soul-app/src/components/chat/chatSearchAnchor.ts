import type { ChatRenderItem } from './groupChatEvents';

export function findChatRenderItemKeyForEvent(
  items: ChatRenderItem[],
  eventId: number,
): string | null {
  return items.find((item) => renderItemContainsEventId(item, eventId))?.key ?? null;
}

export function renderItemContainsEventId(
  item: ChatRenderItem,
  eventId: number,
): boolean {
  if (item.kind === 'typing') return false;
  if (item.kind === 'jev-candidates') return false;
  if (item.kind === 'turn-usage') {
    return Number(item.event.id) === eventId
      || item.summaries?.some((summary) => Number(summary.event.id) === eventId) === true;
  }
  if (item.kind === 'turn-summary') {
    return Number(item.event.id) === eventId;
  }
  if (item.kind === 'tool') {
    return (
      Number(item.start.id) === eventId ||
      Number(item.result?.id) === eventId ||
      item.summaries?.some((summary) => Number(summary.event.id) === eventId) === true
    );
  }
  if (item.kind === 'agent-message-group') {
    return item.events.some((row) => Number(row.event.id) === eventId
      || row.summaries?.some((summary) => Number(summary.event.id) === eventId) === true);
  }
  if (item.kind === 'activity') {
    return item.items.some((entry) => {
      if (entry.kind === 'tool') {
        return (
          Number(entry.start.id) === eventId ||
          Number(entry.result?.id) === eventId ||
          entry.summaries?.some((summary) => Number(summary.event.id) === eventId) === true
        );
      }
      return (
        Number(entry.event.id) === eventId ||
        entry.summaries?.some((summary) => Number(summary.event.id) === eventId) === true
      );
    });
  }
  return (
    Number(item.event.id) === eventId ||
    item.summaries?.some((summary) => Number(summary.event.id) === eventId) === true
  );
}
