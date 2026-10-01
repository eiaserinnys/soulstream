import type { SessionEvent } from '../../api/types';
import { extractEventCopyText } from './eventActions';

export interface MessageSelectionModel {
  kind: 'markdown' | 'plain';
  text: string;
}

function isLiveOnly(event: SessionEvent): boolean {
  return (event.data as Record<string, unknown> | undefined)?._live_only === true;
}

export function createMessageSelectionModel(
  event: SessionEvent,
): MessageSelectionModel | null {
  let kind: MessageSelectionModel['kind'];

  switch (event.type) {
    case 'user_message':
    case 'intervention_sent':
    case 'text_delta':
      kind = 'plain';
      break;
    case 'assistant_message':
      kind = isLiveOnly(event) ? 'plain' : 'markdown';
      break;
    case 'realtime_transcript':
      kind = (event.data as Record<string, unknown> | undefined)?.role === 'user'
        ? 'plain'
        : 'markdown';
      break;
    default:
      return null;
  }

  const text = extractEventCopyText(event);
  return text.trim() ? { kind, text } : null;
}
