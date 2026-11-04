import type { SessionEvent } from '../../api/types';
import { isCardNoticeInput } from '../../../../packages/wire-schema/src/conversation_visibility';

const CACHE_KEEPALIVE_PURPOSE = 'cache_keepalive';

export interface HiddenConversationProjection {
  displayEvents: SessionEvent[];
  suppressStreaming: boolean;
}

function isInputEvent(event: SessionEvent): boolean {
  return event.type === 'user_message' || event.type === 'intervention_sent';
}

function nestedPayload(event: SessionEvent): Record<string, unknown> | undefined {
  const payload = event.data.payload;
  return payload !== null && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : undefined;
}

function isCacheKeepaliveInput(event: SessionEvent): boolean {
  return isInputEvent(event) && (
    event.data.purpose === CACHE_KEEPALIVE_PURPOSE
    || nestedPayload(event)?.purpose === CACHE_KEEPALIVE_PURPOSE
  );
}

function isCardNoticeEvent(event: SessionEvent): boolean {
  const nested = nestedPayload(event);
  return isCardNoticeInput(event.type, event.data)
    || (nested !== undefined && isCardNoticeInput(event.type, nested));
}

export function isHiddenConversationInput(event: SessionEvent): boolean {
  return isCacheKeepaliveInput(event) || isCardNoticeEvent(event);
}

function inputAnchorId(event: SessionEvent): string | null {
  const direct = event.data.input_id;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  if (isCardNoticeEvent(event)) {
    const nested = nestedPayload(event)?.input_id;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }

  if (event.type === 'debug' && event.data.kind === 'persistent_jev_candidates') {
    const observation = event.data.observation;
    if (observation !== null && typeof observation === 'object') {
      const inputId = (observation as Record<string, unknown>).input_id;
      if (typeof inputId === 'string' && inputId.length > 0) return inputId;
    }
  }
  return null;
}

/** Project hidden inputs and their output without altering the underlying events. */
export function projectHiddenConversationTurns(
  events: SessionEvent[],
  pendingInput?: SessionEvent,
): HiddenConversationProjection {
  const keepaliveInputIds = new Set<string>();
  const noticeInputIds = new Set<string>();
  const turnNoticeInputIds = new Set<string>();
  let hidingTurn = false;
  let hasVisibleInput = false;
  const visible: SessionEvent[] = [];

  for (const event of events) {
    if (isInputEvent(event)) {
      const keepalive = isCacheKeepaliveInput(event);
      const notice = isCardNoticeEvent(event);
      if (keepalive || notice) {
        if (keepalive || !hasVisibleInput) {
          hidingTurn = true;
          const inputId = inputAnchorId(event);
          if (inputId !== null) {
            if (keepalive) keepaliveInputIds.add(inputId);
            else {
              noticeInputIds.add(inputId);
              turnNoticeInputIds.add(inputId);
            }
          }
        }
      } else {
        hidingTurn = false;
        hasVisibleInput = true;
        for (const inputId of turnNoticeInputIds) noticeInputIds.delete(inputId);
        turnNoticeInputIds.clear();
        visible.push(event);
      }
      continue;
    }

    if (event.type === 'generation_started') {
      visible.push(event);
      continue;
    }

    if (event.type === 'complete' || event.type === 'error') {
      const wasHiding = hidingTurn;
      hidingTurn = false;
      hasVisibleInput = false;
      turnNoticeInputIds.clear();
      if (wasHiding) {
        if (event.type === 'error') visible.push(event);
        continue;
      }
    }

    if (hidingTurn) continue;
    const anchor = inputAnchorId(event);
    if (anchor === null || (!keepaliveInputIds.has(anchor) && !noticeInputIds.has(anchor))) {
      visible.push(event);
    }
  }

  if (pendingInput && isInputEvent(pendingInput)) {
    if (isCacheKeepaliveInput(pendingInput)) hidingTurn = true;
    else if (isCardNoticeEvent(pendingInput)) hidingTurn ||= !hasVisibleInput;
    else hidingTurn = false;
  }

  return { displayEvents: visible, suppressStreaming: hidingTurn };
}
