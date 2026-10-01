export type SessionSearchIntent = {
  readonly sessionId: string;
  readonly eventId?: number;
};

export type ParsedSessionSearchIntent =
  | { readonly kind: 'intent'; readonly intent: SessionSearchIntent }
  | { readonly kind: 'invalid'; readonly reason: 'empty_session' | 'invalid_event' };

/** Parse the canonical root query from app-scheme and universal links. */
export function parseSessionSearchIntentUrl(
  value: string,
): ParsedSessionSearchIntent | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const isAppRoot = url.protocol === 'soulstream:'
    && url.hostname === ''
    && (url.pathname === '' || url.pathname === '/');
  const isWeb = url.protocol === 'https:' || url.protocol === 'http:';
  const isWebRoot = isWeb
    && url.pathname === '/';
  const isLegacyWebRoute = isWeb && url.pathname === '/v1';
  if (!isAppRoot && !isWebRoot && !isLegacyWebRoute) return null;

  if ((isAppRoot || isWebRoot) && url.searchParams.has('session')) {
    const sessionId = url.searchParams.get('session');
    if (sessionId === null || sessionId.length === 0) {
      return { kind: 'invalid', reason: 'empty_session' };
    }
    const event = url.searchParams.get('event');
    if (event === null) return { kind: 'intent', intent: { sessionId } };
    if (!/^\d+$/.test(event)) {
      return { kind: 'invalid', reason: 'invalid_event' };
    }
    const eventId = Number(event);
    if (!Number.isSafeInteger(eventId) || eventId < 1) {
      return { kind: 'invalid', reason: 'invalid_event' };
    }
    return { kind: 'intent', intent: { sessionId, eventId } };
  }

  if (!isLegacyWebRoute) return null;
  const legacy = url.hash.match(/^#\/feed\/([^/?#]+)(?:\?event=([^&#]+))?$/);
  if (!legacy?.[1]) return null;
  try {
    const sessionId = decodeURIComponent(legacy[1]);
    if (!sessionId) return { kind: 'invalid', reason: 'empty_session' };
    if (legacy[2] === undefined) return { kind: 'intent', intent: { sessionId } };
    const event = decodeURIComponent(legacy[2]);
    if (!/^\d+$/.test(event)) return { kind: 'invalid', reason: 'invalid_event' };
    const eventId = Number(event);
    if (!Number.isSafeInteger(eventId) || eventId < 1) {
      return { kind: 'invalid', reason: 'invalid_event' };
    }
    return { kind: 'intent', intent: { sessionId, eventId } };
  } catch {
    return null;
  }
}
