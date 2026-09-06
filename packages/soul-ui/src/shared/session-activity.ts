import type { LastMessage, SessionSummary } from "./session-types";

export type ReadableMessageType = "user_message" | "assistant_message";

export type NormalizedLastMessage = LastMessage & {
  type: ReadableMessageType;
  eventId?: number;
};

const MAX_PREVIEW_CODEPOINTS = 200;

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Normalize the compact latest-readable-message projection at the client boundary. */
export function normalizeLastMessage(raw: unknown): NormalizedLastMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.type !== "user_message" && value.type !== "assistant_message") {
    return undefined;
  }
  if (typeof value.preview !== "string" || !validTimestamp(value.timestamp)) {
    return undefined;
  }

  const preview = Array.from(value.preview.trim())
    .slice(0, MAX_PREVIEW_CODEPOINTS)
    .join("");
  if (preview.length === 0) return undefined;

  const rawEventId = value.eventId ?? value.event_id;
  const eventId = typeof rawEventId === "number"
    && Number.isSafeInteger(rawEventId)
    && rawEventId > 0
      ? rawEventId
      : undefined;

  return {
    type: value.type,
    preview,
    timestamp: value.timestamp,
    ...(eventId === undefined ? {} : { eventId }),
  };
}

/**
 * Feed activity is message activity, not arbitrary lifecycle mutation time.
 * createdAt and updatedAt are compatibility fallbacks for sessions without a projection.
 */
export function getSessionActivityTimestamp(
  session: Pick<SessionSummary, "lastMessage" | "createdAt" | "updatedAt">,
): string | undefined {
  const candidates = [
    session.lastMessage?.timestamp,
    session.createdAt,
    session.updatedAt,
  ];
  return candidates.find(validTimestamp);
}

export function getSessionActivityMs(
  session: Pick<SessionSummary, "lastMessage" | "createdAt" | "updatedAt">,
): number {
  const timestamp = getSessionActivityTimestamp(session);
  return timestamp === undefined ? 0 : Date.parse(timestamp);
}

/** Newest readable activity first, with stable cross-session pagination ties. */
export function compareSessionActivityDesc(
  left: Pick<SessionSummary, "agentSessionId" | "lastMessage" | "createdAt" | "updatedAt">,
  right: Pick<SessionSummary, "agentSessionId" | "lastMessage" | "createdAt" | "updatedAt">,
): number {
  const activity = getSessionActivityMs(right) - getSessionActivityMs(left);
  if (activity !== 0) return activity;
  if (left.agentSessionId === right.agentSessionId) return 0;
  return left.agentSessionId < right.agentSessionId ? -1 : 1;
}
