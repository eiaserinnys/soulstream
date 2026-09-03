import type {
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";
import { discardSessionDeliveryNotificationProjection } from
  "./session_delivery_notification_projection_repository.js";

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
  return await withConsumptionTransaction(sql, async (transaction) => {
    // A successful turn is the first durable receipt for live input. Transcript
    // recovery may already have projected a target receipt, which stays immutable.
    const rows = await transaction<SessionDeliveryRow[]>`
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
        AND state IN ('pending', 'claimed', 'dispatching', 'queued', 'delivered')
      RETURNING *
    `;
    if (!rows[0]) return null;
    await discardSessionDeliveryNotificationProjection(transaction, deliveryId);
    return rows[0];
  });
}

async function withConsumptionTransaction<T>(
  sql: SqlClient,
  operation: (transaction: SqlClient) => Promise<T>,
): Promise<T> {
  return typeof sql.begin === "function"
    ? await sql.begin(async (transaction) =>
        await operation(transaction as unknown as SqlClient)) as T
    : await operation(sql);
}
