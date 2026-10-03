import type { RepositorySql } from "./control_plane/card_types.js";

/** Shared eligibility for manual claim and the reminder's unclaimed root lookup. */
export async function claimableCardSessions(sql: RepositorySql, cardId: string, sessionId: string | null = null) {
  return sql<{ session_id: string }[]>`
    SELECT s.session_id FROM cards c JOIN sessions s ON s.card_id=c.id AND s.agent_id=c.assignee_agent_id
    WHERE c.id=${cardId} AND c.assignee_session_id IS NULL AND c.assignee_kind='agent'
      AND (${sessionId}::text IS NULL OR s.session_id=${sessionId})
      AND NOT EXISTS (SELECT 1 FROM sessions caller WHERE caller.session_id=s.caller_session_id AND caller.card_id=c.id)
    ORDER BY s.created_at DESC,s.session_id COLLATE "C" DESC`;
}

export function invalidCard(message: string) {
  return Object.assign(new Error(message), { statusCode: 422, code: "INVALID_CARD_REQUEST" });
}

export async function assertSingleCardAssignee(sql: RepositorySql, sessionId: string, cardId: string) {
  const other=(await sql<{id:string}[]>`SELECT id FROM cards WHERE assignee_session_id=${sessionId} AND NOT archived AND id<>${cardId} LIMIT 1`)[0];
  if (other) throw ownershipConflict(other.id);
}

function ownershipConflict(cardId: string) {
  return invalidCard(`이미 카드 ${cardId}의 담당입니다. A/S는 그 카드에 커멘트로, 새 업무는 assignee를 생략하고 queue=true로 새 카드를 만듭니다.`);
}

/** The unique index closes concurrent writes after the friendly preflight query. */
export async function translateAssigneeConflict(sql: RepositorySql, error: unknown, sessionId: string | null | undefined): Promise<never> {
  if ((error as {code?:string;constraint_name?:string})?.code === "23505"
    && (error as {constraint_name?:string}).constraint_name === "uq_cards_assignee_session" && sessionId) {
    const other=(await sql<{id:string}[]>`SELECT id FROM cards WHERE assignee_session_id=${sessionId} AND NOT archived LIMIT 1`)[0];
    throw ownershipConflict(other?.id ?? sessionId);
  }
  throw error;
}
