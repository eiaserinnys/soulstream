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

function inputAnchorId(event: SessionEvent): string | null {
  const direct = event.data.input_id;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  if (event.type === 'debug' && event.data.kind === 'persistent_jev_candidates') {
    const observation = event.data.observation;
    if (observation !== null && typeof observation === 'object') {
      const inputId = (observation as Record<string, unknown>).input_id;
      if (typeof inputId === 'string' && inputId.length > 0) return inputId;
    }
  }
  return null;
}

/** Hide marked turns through their terminal, then hide only rows anchored to that input. */
export function projectCacheKeepaliveTurns(
  events: SessionEvent[],
  pendingInput?: SessionEvent,
): CacheKeepaliveProjection {
  const hiddenInputIds = new Set<string>();
  let hidingKeepaliveTurn = false;
  let activeKeepaliveTurn = false;
  const visible: SessionEvent[] = [];

  for (const event of events) {
    if (isInputEvent(event)) {
      hidingKeepaliveTurn = isCacheKeepaliveInput(event);
      activeKeepaliveTurn = hidingKeepaliveTurn;
      if (hidingKeepaliveTurn) {
        const inputId = inputAnchorId(event);
        if (inputId !== null) hiddenInputIds.add(inputId);
      }
      if (!hidingKeepaliveTurn) visible.push(event);
      continue;
    }

    if (event.type === 'generation_started') {
      visible.push(event);
      continue;
    }

    if (activeKeepaliveTurn && event.type === 'complete') {
      activeKeepaliveTurn = false;
      hidingKeepaliveTurn = false;
      continue;
    }
    if (activeKeepaliveTurn && event.type === 'error') {
      activeKeepaliveTurn = false;
      hidingKeepaliveTurn = false;
      visible.push(event);
      continue;
    }

    if (hidingKeepaliveTurn) continue;
    const anchor = inputAnchorId(event);
    if (anchor === null || !hiddenInputIds.has(anchor)) visible.push(event);
  }

  if (pendingInput && isInputEvent(pendingInput)) {
    activeKeepaliveTurn = isCacheKeepaliveInput(pendingInput);
  }

  return { displayEvents: visible, suppressStreaming: activeKeepaliveTurn };
}
