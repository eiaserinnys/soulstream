import type { ChatEventRenderItem, ChatRenderItem, ChatToolRenderItem } from './groupChatEvents';

export type ManuscriptActivityEntry = ChatToolRenderItem | ChatEventRenderItem;

export type ManuscriptActivityRenderItem = {
  kind: 'activity';
  items: ManuscriptActivityEntry[];
  key: string;
};

function isThinkingItem(item: ChatRenderItem): item is ChatEventRenderItem {
  return item.kind === 'event' && (
    item.event.type === 'thinking_start' ||
    item.event.type === 'thinking_delta' ||
    item.event.type === 'thinking_end'
  );
}

function isManuscriptActivityEntry(
  item: ChatRenderItem,
): item is ManuscriptActivityEntry {
  return item.kind === 'tool' || isThinkingItem(item);
}

function isInvisibleEventItem(item: ChatRenderItem): item is ChatEventRenderItem {
  if (item.kind !== 'event') return false;
  return (
    item.event.type === 'session_start' ||
    item.event.type === 'input_request_expired' ||
    item.event.type === 'input_request_responded' ||
    item.event.type === 'tool_approval_resolved' ||
    item.event.type === 'history_sync'
  );
}

/** Fold each contiguous manuscript run of tools and thinking rows into one row. */
export function projectManuscriptActivity(
  items: ChatRenderItem[],
  enabled = true,
): ChatRenderItem[] {
  if (!enabled) return items;

  const projected: ChatRenderItem[] = [];
  let run: ChatRenderItem[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const entries = run
      .filter(isManuscriptActivityEntry)
      .map((entry) => entry.kind === 'tool' && entry.summaries?.length
        ? { ...entry, summaries: undefined }
        : entry);
    if (entries.some((item) => item.kind === 'tool')) {
      projected.push({
        kind: 'activity',
        key: `activity-${entries[0].key}`,
        items: entries,
      });
    } else {
      projected.push(...run);
    }
    run = [];
  };

  for (const item of items) {
    if (isManuscriptActivityEntry(item)) {
      run.push(item);
      if (item.kind === 'tool' && item.summaries?.length) {
        flush();
        projected.push(...item.summaries);
      }
    } else if (isInvisibleEventItem(item)) {
      run.push(item);
    } else {
      flush();
      projected.push(item);
    }
  }
  flush();
  return projected;
}
