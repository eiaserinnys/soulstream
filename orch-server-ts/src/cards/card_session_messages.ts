import type { SqlClient } from "./control_plane/card_types.js";
import { CardOperationError, type CardDetail } from "./card_operations.js";
import { readSessionConversation, type CardSessionMessages } from "../session/session_conversation_projection.js";
export type { CardSessionMessage, CardSessionMessages } from "../session/session_conversation_projection.js";

export type CardSessionMessagesQuery = {
  sessionId?: string | null;
  limit?: number | string | null;
};

/** Reads the conversation of a card-linked session through the shared projection. */
export async function readCardSessionMessages(
  sql: SqlClient,
  detail: CardDetail,
  query?: CardSessionMessagesQuery,
): Promise<CardSessionMessages> {
  const requested = typeof query?.sessionId === "string" ? query.sessionId.trim() : "";
  const linked = (sessionId: string) => detail.card.assignee_session_id === sessionId
    || detail.sessions.some(session => session.session_id === sessionId);
  if (requested && !linked(requested)) throw new CardOperationError("카드에 연결된 세션이 아닙니다.", 422);
  const targetSessionId = requested || detail.card.assignee_session_id || firstSessionId(detail) || null;
  if (targetSessionId === null) return { sessionId: null, session: null, busy: false, tool: null, items: [] };

  const sessionRow = detail.sessions.find(session => session.session_id === targetSessionId) ?? null;
  return await readSessionConversation(sql, targetSessionId, sessionRow, detail.card.assignee_agent_id, query?.limit);
}
function firstSessionId(detail: CardDetail): string | null {
  const value = detail.sessions[0]?.session_id;
  return typeof value === "string" ? value : null;
}
