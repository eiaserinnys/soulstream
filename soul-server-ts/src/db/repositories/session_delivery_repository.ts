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
      WHERE delivery_id = ${deliveryId} AND state IN ('pending', 'claimed')
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  /**
   * Resolves the active supervisor and claims the durable delivery in one
   * statement. Pending and not-yet-dispatched claims may be retargeted after a
   * handover; dispatching/terminal rows remain immutable.
   */
  async claimForCurrentSupervisor(
    deliveryId: string,
    supervisorRole: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries AS delivery
      SET
        target_session_id = registry.active_session_id,
        supervisor_role = ${supervisorRole},
        state = 'claimed',
        claimed_at = COALESCE(delivery.claimed_at, NOW()),
        updated_at = NOW()
      FROM supervisor_registry AS registry
      WHERE delivery.delivery_id = ${deliveryId}
        AND delivery.state IN ('pending', 'claimed')
        AND delivery.supervisor_role = ${supervisorRole}
        AND registry.role = ${supervisorRole}
        AND registry.active_session_id IS NOT NULL
      RETURNING delivery.*
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async beginDispatch(deliveryId: string): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries AS delivery
      SET state = 'dispatching', dispatching_at = NOW(), updated_at = NOW()
      WHERE delivery.delivery_id = ${deliveryId}
        AND delivery.state = 'claimed'
        AND (
          delivery.supervisor_role IS NULL
          OR EXISTS (
            SELECT 1
            FROM supervisor_registry AS registry
            WHERE registry.role = delivery.supervisor_role
              AND registry.active_session_id = delivery.target_session_id
          )
        )
      RETURNING delivery.*
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async listRecoverableCompletionDeliveries(
    limit = 100,
  ): Promise<SessionDeliveryRow[]> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      SELECT *
      FROM session_deliveries
      WHERE intent = 'completion_notification'
        AND source = 'completion_notifier'
        AND state IN ('pending', 'claimed')
      ORDER BY updated_at, created_at, delivery_id
      LIMIT ${limit}
    `;
    return rows.map(normalizeDeliveryRow);
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
        AND state IN ('pending', 'claimed')
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
  return row;
}
