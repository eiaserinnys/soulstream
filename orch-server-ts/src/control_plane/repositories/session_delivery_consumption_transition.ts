import type {
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";

/**
 * Applies the canonical success-to-consumed transition by exact delivery id.
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
  // A successful turn is the first durable receipt for live input. Transcript
  // recovery may already have projected a target receipt, which stays immutable.
  const rows = await sql<SessionDeliveryRow[]>`
    UPDATE session_deliveries
    SET
      state = 'consumed',
      aggregate_state = 'consumed',
      caller_turn_id = ${consumedTurnId},
      target_receipt_id = COALESCE(target_receipt_id, ${consumedTurnId}),
      target_receipt_at = COALESCE(target_receipt_at, NOW()),
      delivered_at = COALESCE(delivered_at, NOW()),
      consumed_at = NOW(),
      updated_at = NOW()
    WHERE delivery_id = ${deliveryId}
      AND aggregate_state IN ('pending', 'delivered')
      AND state IN ('queued', 'delivered')
    RETURNING *
  `;
  return rows[0] ?? null;
}
