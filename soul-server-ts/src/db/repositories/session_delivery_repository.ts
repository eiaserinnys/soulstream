import type {
  RegisterSessionDeliveryParams,
  RegisterSessionDeliveryResult,
  SessionDeliveryRow,
  SqlClient,
} from "../session_db_types.js";
import { asPostgresJsonValue } from "./repository_helpers.js";

export class SessionDeliveryRepository {
  constructor(private readonly sql: SqlClient) {}

  async register(
    params: RegisterSessionDeliveryParams,
  ): Promise<RegisterSessionDeliveryResult> {
    const insertedRows = await this.sql<SessionDeliveryRow[]>`
      INSERT INTO session_deliveries (
        delivery_id,
        target_session_id,
        source_session_id,
        relation_key,
        completion_id,
        intent,
        source,
        producer_kind,
        producer_id,
        producer_terminal_revision,
        parent_delivery_id,
        caller_turn_id,
        supervisor_role,
        supervisor_epoch,
        payload_hash,
        payload,
        created_at,
        updated_at
      ) VALUES (
        ${params.deliveryId},
        ${params.targetSessionId},
        ${params.sourceSessionId ?? null},
        ${params.relationKey},
        ${params.completionId ?? null},
        ${params.intent},
        ${params.source},
        ${params.producerKind ?? null},
        ${params.producerId ?? null},
        ${params.producerTerminalRevision ?? null},
        ${params.parentDeliveryId ?? null},
        ${params.callerTurnId ?? null},
        ${params.supervisorRole ?? null},
        ${params.supervisorEpoch ?? null},
        ${params.payloadHash},
        ${this.sql.json(asPostgresJsonValue(params.payload))},
        ${params.createdAt ?? new Date()},
        ${params.createdAt ?? new Date()}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    const inserted = insertedRows[0];
    if (inserted) {
      return { row: normalizeDeliveryRow(inserted), inserted: true, conflict: false };
    }

    const existingRows = await this.sql<SessionDeliveryRow[]>`
      SELECT *
      FROM session_deliveries
      WHERE delivery_id = ${params.deliveryId}
         OR relation_key = ${params.relationKey}
      ORDER BY CASE WHEN delivery_id = ${params.deliveryId} THEN 0 ELSE 1 END
      LIMIT 1
    `;
    const existing = existingRows[0]
      ? normalizeDeliveryRow(existingRows[0])
      : undefined;
    if (!existing) {
      throw new Error(`Delivery disappeared after registration conflict: ${params.deliveryId}`);
    }

    const conflict =
      existing.delivery_id !== params.deliveryId ||
      existing.relation_key !== params.relationKey ||
      existing.payload_hash !== params.payloadHash ||
      existing.intent !== params.intent ||
      existing.completion_id !== (params.completionId ?? null);
    if (!conflict) {
      return { row: existing, inserted: false, conflict: false };
    }

    const uncertain = await this.markUncertain(existing.delivery_id);
    return { row: uncertain ?? { ...existing, state: "uncertain" }, inserted: false, conflict: true };
  }

  async get(deliveryId: string): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      SELECT * FROM session_deliveries WHERE delivery_id = ${deliveryId}
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async getByRelation(relationKey: string): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      SELECT *
      FROM session_deliveries
      WHERE relation_key = ${relationKey}
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async claim(deliveryId: string): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET state = 'claimed', claimed_at = NOW(), updated_at = NOW()
      WHERE delivery_id = ${deliveryId} AND state = 'pending'
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async claimForTarget(
    deliveryId: string,
    targetSessionId: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        target_session_id = ${targetSessionId},
        state = 'claimed',
        claimed_at = NOW(),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId} AND state = 'pending'
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  /**
   * Claims only while the producer's supervisor snapshot is still current.
   * A handover between lookup and this statement leaves the delivery pending,
   * allowing the producer to resolve the new active supervisor and retry.
   */
  async claimForSupervisorTarget(
    deliveryId: string,
    targetSessionId: string,
    supervisorRole: string,
    supervisorEpoch: number,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries AS delivery
      SET
        target_session_id = ${targetSessionId},
        supervisor_role = ${supervisorRole},
        supervisor_epoch = ${supervisorEpoch},
        state = 'claimed',
        claimed_at = NOW(),
        updated_at = NOW()
      FROM supervisor_registry AS registry
      WHERE delivery.delivery_id = ${deliveryId}
        AND delivery.state = 'pending'
        AND registry.role = ${supervisorRole}
        AND registry.active_session_id = ${targetSessionId}
        AND registry.epoch = ${supervisorEpoch}
      RETURNING delivery.*
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async beginDispatch(deliveryId: string): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET state = 'dispatching', dispatching_at = NOW(), updated_at = NOW()
      WHERE delivery_id = ${deliveryId} AND state = 'claimed'
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async markQueued(deliveryId: string): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET state = 'queued', queued_at = NOW(), updated_at = NOW()
      WHERE delivery_id = ${deliveryId} AND state IN ('dispatching', 'claimed', 'pending')
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async markDelivered(
    deliveryId: string,
    callerTurnId: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'delivered',
        caller_turn_id = ${callerTurnId},
        delivered_at = NOW(),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND state IN ('dispatching', 'claimed', 'queued')
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async markConsumed(
    deliveryId: string,
    callerTurnId?: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'consumed',
        caller_turn_id = COALESCE(${callerTurnId ?? null}, caller_turn_id),
        consumed_at = NOW(),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND state IN ('pending', 'claimed', 'dispatching', 'queued', 'delivered')
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async markConsumedByRelation(
    relationKey: string,
    completionId: string,
    callerTurnId: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'consumed',
        caller_turn_id = ${callerTurnId},
        consumed_at = NOW(),
        updated_at = NOW()
      WHERE relation_key = ${relationKey}
        AND completion_id = ${completionId}
        AND state IN ('pending', 'claimed', 'queued', 'delivered', 'uncertain')
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async markUncertain(deliveryId: string): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET state = 'uncertain', updated_at = NOW()
      WHERE delivery_id = ${deliveryId} AND state <> 'consumed'
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

}

function normalizeDeliveryRow(row: SessionDeliveryRow): SessionDeliveryRow {
  const epoch = row.supervisor_epoch as number | string | null;
  return {
    ...row,
    supervisor_epoch: epoch === null ? null : Number(epoch),
  };
}
