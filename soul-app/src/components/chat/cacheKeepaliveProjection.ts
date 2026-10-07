import type { SessionEvent } from '../../api/types';

export const CACHE_KEEPALIVE_PURPOSE = 'cache_keepalive';

export interface CacheKeepaliveProjection {
  displayEvents: SessionEvent[];
  suppressStreaming: boolean;
}

function isInputEvent(event: SessionEvent): boolean {
  return event.type === 'user_message' || event.type === 'intervention_sent';
}

function isCacheKeepaliveInput(event: SessionEvent): boolean {
  if (!isInputEvent(event)) return false;
  const payload = event.data.payload;
  const nestedPurpose = payload !== null && typeof payload === 'object'
    ? (payload as Record<string, unknown>).purpose
    : undefined;
  return event.data.purpose === CACHE_KEEPALIVE_PURPOSE
    || nestedPurpose === CACHE_KEEPALIVE_PURPOSE;
}

/** Remove marked inputs and their full event span before chat rows and captions are grouped. */
export function projectCacheKeepaliveTurns(
  events: SessionEvent[],
  pendingInput?: SessionEvent,
): CacheKeepaliveProjection {
  let hidingKeepaliveTurn = false;
  let activeKeepaliveTurn = false;
  const visible: SessionEvent[] = [];

  for (const event of events) {
    if (isInputEvent(event)) {
      hidingKeepaliveTurn = isCacheKeepaliveInput(event);
      activeKeepaliveTurn = hidingKeepaliveTurn;
    } else if (activeKeepaliveTurn && (event.type === 'complete' || event.type === 'error')) {
      activeKeepaliveTurn = false;
    }
    if (!hidingKeepaliveTurn) visible.push(event);
  }

  if (pendingInput && isInputEvent(pendingInput)) {
    activeKeepaliveTurn = isCacheKeepaliveInput(pendingInput);
  }

  return { displayEvents: visible, suppressStreaming: activeKeepaliveTurn };
}
