import { claimableCardSessions } from "./card_assignee.js";
import type { CardRow, SqlClient } from "./control_plane/card_types.js";
import { PENDING_DELIVERY_FAILURE_CEILING_MS, COMPLETION_REGISTRATION_FAILURE_CEILING_MS, type CardReminderFacts } from "./card_status_reminder.js";

/** Reads only existing canonical card, session, ingress and delivery records. */
export async function readCardReminderFacts(sql: SqlClient, now: number, endedRootId?: string): Promise<CardReminderFacts[]> {
  const cards = await sql<CardRow[]>`SELECT * FROM cards c WHERE NOT c.archived
    AND (${endedRootId ?? null}::text IS NULL AND c.status='running'
      OR ${endedRootId ?? null}::text IS NOT NULL AND (c.assignee_session_id=${endedRootId ?? null}
        OR c.assignee_session_id IS NULL AND c.assignee_kind='agent'
          AND EXISTS(SELECT 1 FROM sessions s WHERE s.session_id=${endedRootId ?? null} AND s.card_id=c.id)))
    ORDER BY c.id COLLATE "C"`;
  const result: CardReminderFacts[] = [];
  for (const card of cards) {
    const root = card.assignee_session_id ?? (await claimableCardSessions(sql, card.id))[0]?.session_id;
    if (!root || endedRootId && root !== endedRootId) continue;
    const rows = await sql<CardReminderFacts[]>`
      WITH RECURSIVE tree AS (
        SELECT session_id FROM sessions WHERE session_id=${root}
        UNION
        SELECT child.session_id FROM sessions child JOIN tree parent ON child.caller_session_id=parent.session_id
        WHERE NOT EXISTS (SELECT 1 FROM cards other WHERE other.assignee_session_id=child.session_id
          AND other.id<>${card.id} AND NOT other.archived)
      )
      SELECT c.id AS "cardId",c.status AS "cardStatus",
        (EXTRACT(EPOCH FROM c.status_changed_at)*1000000)::bigint::text AS "statusEpochUs",
        r.session_id AS "rootSessionId",r.status AS "rootStatus",r.termination_reason AS "rootTerminationReason",
        EXISTS(SELECT 1 FROM tree t JOIN sessions s USING(session_id)
          WHERE s.session_id<>r.session_id AND s.status IN ('initializing','running')) AS "activeDescendants",
        EXISTS(SELECT 1 FROM tree t JOIN sessions s USING(session_id)
          WHERE s.status IN ('initializing','running')) AS "activeTree",
        EXISTS(SELECT 1 FROM session_deliveries d JOIN tree t ON t.session_id=d.target_session_id
          WHERE d.aggregate_state='pending' AND d.created_at>${new Date(now - PENDING_DELIVERY_FAILURE_CEILING_MS)}) AS "pendingDeliveries",
        EXISTS(SELECT 1 FROM tree t JOIN sessions s USING(session_id)
          WHERE s.session_id<>r.session_id AND s.status IN ('completed','error','interrupted')
            AND s.notify_completion IS DISTINCT FROM FALSE AND s.termination_detail IS DISTINCT FROM 'user_stop'
            AND s.termination_event_id IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM session_deliveries d WHERE d.relation_key='child_session:'||s.session_id||':'||s.termination_event_id)
            AND NOT EXISTS(SELECT 1 FROM session_delivery_relation_consumptions consumed
              WHERE consumed.relation_key='child_session:'||s.session_id||':'||s.termination_event_id)
            AND EXISTS(SELECT 1 FROM event_ingress_receipts receipt WHERE receipt.session_id=s.session_id
              AND receipt.event_id=s.termination_event_id AND receipt.created_at>${new Date(now - COMPLETION_REGISTRATION_FAILURE_CEILING_MS)})) AS "unregisteredCompletions",
        EXISTS(SELECT 1 FROM event_ingress_receipts receipt WHERE receipt.session_id=r.session_id
          AND receipt.event_id=r.termination_event_id AND receipt.created_at>c.status_changed_at) AS "rootEndedAfterStatus"
      FROM cards c JOIN sessions r ON r.session_id=${root} WHERE c.id=${card.id} AND NOT c.archived`;
    if (rows[0]) result.push(rows[0]);
  }
  return result;
}
