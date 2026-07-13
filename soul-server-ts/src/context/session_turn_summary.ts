import type { SessionDB } from "../db/session_db.js";

const SUMMARY_EVENT_TYPES = [
  "user_message",
  "assistant_message",
  "user_text",
  "assistant_text",
] as const;

export interface SessionTurnExcerpt {
  event_id: number;
  event_type: string;
  text: string;
  created_at: string;
}

export async function buildSessionTurnExcerpt(
  db: Pick<SessionDB, "countEvents" | "readEvents">,
  sessionId: string,
  maxResponseChars = 500,
): Promise<{ totalEvents: number; turns: SessionTurnExcerpt[] }> {
  const totalEvents = await db.countEvents(sessionId);
  const events = await db.readEvents(
    sessionId,
    0,
    Math.min(totalEvents, 200),
    [...SUMMARY_EVENT_TYPES],
  );
  return {
    totalEvents,
    turns: events.map((event) => ({
      event_id: event.id,
      event_type: event.event_type,
      text: truncate(
        extractTextFromPayload(event.payload),
        maxResponseChars > 0 ? maxResponseChars : undefined,
      ),
      created_at: event.created_at.toISOString(),
    })),
  };
}

function extractTextFromPayload(payload: Record<string, unknown>): string {
  for (const key of ["text", "content", "message", "value"]) {
    const value = payload[key];
    if (typeof value === "string") return value;
  }
  return JSON.stringify(payload);
}

function truncate(value: string, limit?: number): string {
  if (limit === undefined || limit === 0) return value;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
