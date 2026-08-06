import type { SessionDB } from "../db/session_db.js";

export interface SessionTurnExcerpt {
  event_id: number;
  event_type: string;
  text: string;
  created_at: string;
}

export async function buildSessionTurnExcerpt(
  db: Pick<SessionDB, "getTurnExcerpt">,
  sessionId: string,
  maxResponseChars = 500,
): Promise<{ totalEvents: number; turns: SessionTurnExcerpt[] }> {
  return await db.getTurnExcerpt(sessionId, maxResponseChars);
}
