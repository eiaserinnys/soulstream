import type { Session } from '../api/types';
import { normalizeFeedLastMessage } from './session-feed-activity';

// PostgreSQL timestamps include microseconds. Date.parse alone would lose the
// fractional tie-break before eventId (session_apply_last_chat_message).
function messageTime(timestamp: string): bigint {
  const fraction = timestamp.match(/\.(\d+)/)?.[1] ?? '';
  return BigInt(Date.parse(timestamp)) * 1000n
    + BigInt(fraction.padEnd(6, '0').slice(3, 6));
}

/** Protect only the preview owner; status/read/name and attention still merge normally. */
export function preserveNewestLastMessage(existing: Session | undefined, incoming: Session): Session {
  const current = normalizeFeedLastMessage(existing?.lastMessage);
  if (!current) return incoming;
  const next = normalizeFeedLastMessage(incoming.lastMessage);
  if (next) {
    const currentTime = messageTime(current.timestamp!);
    const nextTime = messageTime(next.timestamp!);
    // Legacy writes have no eventId and only replace on a strictly later timestamp.
    // Canonical writes treat an existing legacy ID as zero, like the DB function.
    if (nextTime > currentTime || (
      nextTime === currentTime && next.eventId !== undefined
      && next.eventId > (current.eventId ?? 0)
    )) return incoming;
  }
  return { ...incoming, lastMessage: existing!.lastMessage };
}
