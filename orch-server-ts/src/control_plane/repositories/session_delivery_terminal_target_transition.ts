import type { SqlClient } from "../control_plane_types.js";
import { discardSessionDeliveryNotificationProjections } from
  "./session_delivery_notification_projection_repository.js";

/**
 * Settles completion notifications whose target can no longer consume them.
 *
 * An exact relation receipt wins over target lifecycle: it proves the caller
 * already observed this child revision even if the delivery-row ACK was lost.
 * Target lifecycle alone is not content-observation evidence: unreceived rows
 * remain recoverable by the ordinary delivery recovery path.
 */
export async function settleTerminalTargetCompletionDeliveries(
  sql: SqlClient,
): Promise<void> {
  const consumed = await sql<Array<{ delivery_id: string }>>`
    UPDATE session_deliveries AS delivery
    SET
      state = 'consumed',
      aggregate_state = 'consumed',
      caller_turn_id = consumption.consumed_turn_id,
      target_receipt_id = COALESCE(
        delivery.target_receipt_id,
        consumption.consumed_turn_id
      ),
      target_receipt_at = COALESCE(
        delivery.target_receipt_at,
        consumption.consumed_at
      ),
      delivered_at = COALESCE(
        delivery.delivered_at,
        consumption.consumed_at
      ),
      consumed_at = consumption.consumed_at,
      consumed_reason = 'exact relation receipt recovery',
      attempt_token = NULL,
      attempt_expires_at = NULL,
      updated_at = NOW()
    FROM session_delivery_relation_consumptions AS consumption
    WHERE delivery.relation_key = consumption.relation_key
      AND delivery.completion_id = consumption.completion_id
      AND delivery.target_session_id = consumption.caller_session_id
      AND delivery.intent = 'completion_notification'
      AND delivery.source = 'completion_notifier'
      AND delivery.aggregate_state IN ('pending', 'delivered')
      AND delivery.state IN (
        'pending', 'claimed', 'dispatching', 'queued', 'delivered'
      )
    RETURNING delivery.delivery_id
  `;
  await discardSessionDeliveryNotificationProjections(
    sql,
    consumed.map((row) => row.delivery_id),
  );
}
