import type { RegisterSessionDeliveryParams, SessionDeliveryRelationConsumptionRow, SessionDeliveryRow } from "@soulstream/wire-schema/session-delivery";
import type { SqlClient } from "../control_plane_types.js";
import { asPostgresJsonValue } from "../repository_helpers.js";
import { appendSessionDeliveryAttempt } from "./session_delivery_attempt_repository.js";

export async function insertSessionDeliveryRow(
  transaction: SqlClient,
  params: RegisterSessionDeliveryParams,
  consumption: SessionDeliveryRelationConsumptionRow | undefined,
): Promise<SessionDeliveryRow[]> {
  const createdAt = params.createdAt ?? new Date();
  return await transaction<SessionDeliveryRow[]>`
    INSERT INTO session_deliveries (
      delivery_id, target_session_id, source_session_id, relation_key,
      completion_id, intent, source, producer_kind, producer_id,
      producer_terminal_revision, parent_delivery_id, caller_turn_id,
      payload_hash, payload, state, aggregate_state,
      target_receipt_id, target_receipt_at,
      created_at, updated_at, consumed_at, consumed_reason
    ) VALUES (
      ${params.deliveryId}, ${params.targetSessionId ?? null},
      ${params.sourceSessionId ?? null}, ${params.relationKey},
      ${params.completionId ?? null}, ${params.intent}, ${params.source},
      ${params.producerKind ?? null}, ${params.producerId ?? null},
      ${params.producerTerminalRevision ?? null},
      ${params.parentDeliveryId ?? null}, ${params.callerTurnId ?? null},
      ${params.payloadHash},
      ${transaction.json(asPostgresJsonValue(params.payload))},
      ${consumption ? "consumed" : "pending"},
      ${consumption ? "consumed" : "pending"},
      ${consumption?.consumed_turn_id ?? null},
      ${consumption?.consumed_at ?? null},
      ${createdAt}, ${createdAt}, ${consumption?.consumed_at ?? null},
      ${consumption ? "relation already consumed" : null}
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
}

export async function markDeliveryIdentityConflict(
  transaction: SqlClient,
  existing: SessionDeliveryRow,
): Promise<SessionDeliveryRow | null> {
  const uncertainRows = await transaction<SessionDeliveryRow[]>`
    UPDATE session_deliveries
    SET state = 'uncertain', aggregate_state = 'dead_letter',
        dead_letter_reason = 'delivery identity conflict',
        dead_lettered_at = NOW(), updated_at = NOW()
    WHERE delivery_id = ${existing.delivery_id}
      AND state NOT IN ('consumed', 'superseded')
    RETURNING *
  `;
  if (uncertainRows[0]) {
    await appendSessionDeliveryAttempt(transaction, {
      deliveryId: existing.delivery_id,
      outcome: "rejected",
      reason: "delivery identity conflict",
    });
  }
  return uncertainRows[0] ?? null;
}
