import type {
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";

/**
 * Applies the canonical delivered-to-consumed transition by exact delivery id.
 *
 * The caller supplies the SQL boundary so recovery can compose transcript
 * delivery proof and consumption atomically without inventing another wire
 * operation or another state transition.
 */
export async function markSessionDeliveryConsumed(
  sql: SqlClient,
  deliveryId: string,
  consumedTurnId: string,
): Promise<SessionDeliveryRow | null> {
  // target_receipt_id proves that this delivery reached the target and stays
  // immutable. caller_turn_id identifies the later foreground turn that
  // consumed it; lastEventId may advance between those two boundaries.
  const rows = await sql<SessionDeliveryRow[]>`
    UPDATE session_deliveries
    SET
      state = 'consumed',
      aggregate_state = 'consumed',
      caller_turn_id = ${consumedTurnId},
      consumed_at = NOW(),
      updated_at = NOW()
    WHERE delivery_id = ${deliveryId}
      AND aggregate_state = 'delivered'
      AND target_receipt_id IS NOT NULL
      AND state IN ('delivered', 'queued')
    RETURNING *
  `;
  return rows[0] ?? null;
}
