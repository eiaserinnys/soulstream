import type { SqlClient } from "../control_plane_types.js";

const CONSUMED_PROJECTION_ERROR =
  "delivery aggregate consumed before notification projection";

export async function lockSessionDelivery(
  sql: SqlClient,
  deliveryId: string,
): Promise<boolean> {
  const rows = await sql<Array<{ delivery_id: string }>>`
    SELECT delivery_id
    FROM session_deliveries
    WHERE delivery_id = ${deliveryId}
    FOR UPDATE
  `;
  return Boolean(rows[0]);
}

export async function lockSessionDeliveries(
  sql: SqlClient,
  deliveryIds: readonly string[],
): Promise<void> {
  const orderedIds = [...new Set(deliveryIds)].sort();
  if (orderedIds.length === 0) return;
  await sql`
    SELECT delivery_id
    FROM session_deliveries
    WHERE delivery_id = ANY(${orderedIds}::text[])
    ORDER BY delivery_id
    FOR UPDATE
  `;
}

export async function discardSessionDeliveryNotificationProjection(
  sql: SqlClient,
  deliveryId: string,
  reason = CONSUMED_PROJECTION_ERROR,
): Promise<void> {
  await discardSessionDeliveryNotificationProjections(sql, [deliveryId], reason);
}

export async function discardSessionDeliveryNotificationProjections(
  sql: SqlClient,
  deliveryIds: readonly string[],
  reason = CONSUMED_PROJECTION_ERROR,
): Promise<void> {
  const uniqueIds = [...new Set(deliveryIds)];
  if (uniqueIds.length === 0) return;
  await sql`
    UPDATE session_delivery_notification_outbox
    SET
      state = 'dead_letter',
      projection_state = 'discarded',
      attempt_token = NULL,
      attempt_expires_at = NULL,
      last_error = ${reason},
      dead_lettered_at = COALESCE(dead_lettered_at, NOW()),
      updated_at = NOW()
    WHERE delivery_id = ANY(${uniqueIds}::text[])
      AND state IN ('pending', 'claimed')
  `;
}

export async function discardTerminalResumeNotificationProjections(
  sql: SqlClient,
  sourceSessionId: string,
  terminalRevision: number,
): Promise<void> {
  await sql`
    UPDATE session_delivery_notification_outbox AS outbox
    SET
      state = 'dead_letter',
      projection_state = 'discarded',
      attempt_token = NULL,
      attempt_expires_at = NULL,
      last_error = ${CONSUMED_PROJECTION_ERROR},
      dead_lettered_at = COALESCE(outbox.dead_lettered_at, NOW()),
      updated_at = NOW()
    FROM session_deliveries AS delivery
    WHERE outbox.delivery_id = delivery.delivery_id
      AND delivery.source_session_id = ${sourceSessionId}
      AND delivery.intent = 'completion_notification'
      AND delivery.source = 'completion_notifier'
      AND delivery.producer_kind = 'child_session'
      AND delivery.producer_terminal_revision = ${String(terminalRevision)}
      AND delivery.aggregate_state = 'consumed'
      AND delivery.state = 'superseded'
      AND outbox.state IN ('pending', 'claimed')
  `;
}
