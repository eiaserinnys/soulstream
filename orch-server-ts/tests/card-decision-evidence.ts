import { hasUserInputAfterLastReplyTx } from '../src/cards/control_plane/card_item_store.js';
import type { CardMachineWorld } from './card-machine-world.js';
import { cardCapacitySessions } from '../src/cards/card_capacity.js';
import { createFolderContentSqlAdapter } from '../src/board/folder_content_sql.js';

/** Raw boundary reads only. No decision facts, permission or write policy lives here. */
export async function collectDecisionReads(world: CardMachineWorld, command: Record<string, any>, cardId?: string) {
  const sql = world.h.sql;
  const ids = [...new Set([cardId, command.targetCardId, ...(command.sourceCardIds ?? []), ...(command.cardIds ?? [])].filter(Boolean))];
  return {
    userInputAfterLastReply: cardId ? await hasUserInputAfterLastReplyTx(createFolderContentSqlAdapter(world.h.liveSql), cardId) : false,
    executionStatusChanged: command.requestId && cardId ? (await sql`SELECT c.status_changed_at>r.updated_at AS changed FROM cards c
      JOIN card_execution_requests r ON r.card_id=c.id WHERE c.id=${cardId} AND r.id=${command.requestId} AND r.session_id=${command.sessionId}`)[0]?.changed === true : false,
    orchestrationPolicy: (await sql`SELECT * FROM system_settings WHERE setting_key='card_orchestration'`)[0] ?? null,
    dispatchPolicy: (await sql`SELECT * FROM system_settings WHERE setting_key='card_dispatch'`)[0] ?? null,
    admissionRun: command.admission ? (await sql`SELECT * FROM card_orchestration_runs WHERE id=${command.admission.runId}`)[0] ?? null : null,
    dispatchRuns: await sql`SELECT r.* FROM card_orchestration_runs r WHERE EXISTS (
      SELECT 1 FROM card_orchestration_dispatches d WHERE d.run_id=r.id AND d.card_id=ANY(${ids}::text[])) ORDER BY r.created_at,r.id`,
    capacitySessions: await cardCapacitySessions(createFolderContentSqlAdapter(world.h.liveSql)),
    // Includes prospective owner, creator, caller and other occupied sessions.
    sessions: await sql`SELECT * FROM sessions ORDER BY session_id COLLATE "C"`,
    cards: await sql`SELECT * FROM cards ORDER BY number,id`,
    folders: await sql`SELECT * FROM folders ORDER BY id`,
    comments: await sql`SELECT * FROM card_comments WHERE card_id=ANY(${ids}::text[]) ORDER BY created_at,id`,
    operations: await sql`SELECT * FROM folder_operations WHERE target_id=ANY(${ids}::text[]) ORDER BY created_at,id`,
    assets: await sql`SELECT * FROM file_assets ORDER BY id`,
    participantRequests: await sql`SELECT * FROM card_execution_requests WHERE card_id=ANY(${ids}::text[]) ORDER BY created_at,id`,
    // acceptQueuedWork checks receipts and deliveries belonging to the active dispatch.
    deliveries: await sql`SELECT delivery.* FROM session_deliveries delivery WHERE EXISTS (
      SELECT 1 FROM card_orchestration_dispatches d WHERE d.card_id=ANY(${ids}::text[])
      AND d.session_id=delivery.target_session_id AND d.input->>'deliveryId'=delivery.delivery_id) ORDER BY delivery.delivery_id`,
    registrations: await sql`SELECT receipt.* FROM event_ingress_receipts receipt WHERE EXISTS (
      SELECT 1 FROM card_orchestration_dispatches d WHERE d.card_id=ANY(${ids}::text[]) AND d.session_id=receipt.session_id
      AND (receipt.created_at>=d.created_at OR receipt.event_id=(SELECT r.event_id FROM event_ingress_receipts r
        JOIN session_deliveries delivery ON delivery.delivery_id=d.input->>'deliveryId'
        WHERE r.session_id=d.session_id AND r.effect_application->>'applied'='true'
        AND r.effect_application->'canonical_execution_registration' IS NOT NULL
        AND r.effect_application->'canonical_execution_registration'<>'null'::jsonb
        AND r.event_id<=CASE WHEN delivery.target_receipt_id ~ '^event:[0-9]+$' THEN substring(delivery.target_receipt_id FROM 7)::int ELSE -1 END
        ORDER BY r.event_id DESC LIMIT 1))) ORDER BY receipt.event_id`,
  };
}
