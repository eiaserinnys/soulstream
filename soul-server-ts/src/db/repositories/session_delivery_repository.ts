import type {
  RecordSessionDeliveryRelationConsumptionParams,
  RecordSessionDeliveryRelationConsumptionResult,
  RegisterSessionDeliveryParams,
  RegisterSessionDeliveryResult,
  SessionDeliveryRelationConsumptionRow,
  SessionDeliveryRow,
  SqlClient,
} from "../session_db_types.js";
import { SessionDeliveryNotificationRepository } from "./session_delivery_notification_repository.js";
import {
  getSessionDeliveryRelationConsumption,
  recordSessionDeliveryRelationConsumed,
  registerSessionDelivery,
} from "./session_delivery_relation_repository.js";

export class SessionDeliveryRepository {
  readonly notifications: SessionDeliveryNotificationRepository;

  constructor(private readonly sql: SqlClient) {
    this.notifications = new SessionDeliveryNotificationRepository(sql);
  }

  async register(
    params: RegisterSessionDeliveryParams,
  ): Promise<RegisterSessionDeliveryResult> {
    return await registerSessionDelivery(this.sql, params);
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

  async getRelationConsumption(
    relationKey: string,
  ): Promise<SessionDeliveryRelationConsumptionRow | null> {
    return await getSessionDeliveryRelationConsumption(this.sql, relationKey);
  }

  async recordRelationConsumed(
    params: RecordSessionDeliveryRelationConsumptionParams,
  ): Promise<RecordSessionDeliveryRelationConsumptionResult> {
    return await recordSessionDeliveryRelationConsumed(this.sql, params);
  }

  async claim(
    deliveryId: string,
    leaseOwner = "legacy",
    leaseMs = 15_000,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'claimed',
        claimed_at = NOW(),
        lease_owner = ${leaseOwner},
        lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId} AND state = 'pending'
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async claimForTarget(
    deliveryId: string,
    targetSessionId: string,
    leaseOwner = "legacy",
    leaseMs = 15_000,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        target_session_id = ${targetSessionId},
        state = 'claimed',
        claimed_at = NOW(),
        lease_owner = ${leaseOwner},
        lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND state = 'pending'
        AND EXISTS (
          SELECT 1 FROM sessions WHERE session_id = ${targetSessionId}
        )
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  /**
   * Resolves the active supervisor and claims the durable delivery in one
   * transaction. The delivery row is locked before a fresh READ COMMITTED
   * supervisor lookup, so a handover committed during the wait is observed.
   * Dispatching/terminal rows remain immutable.
   */
  async claimForCurrentSupervisor(
    deliveryId: string,
    supervisorRole: string,
    leaseOwner = "legacy",
    leaseMs = 15_000,
  ): Promise<SessionDeliveryRow | null> {
    return await this.sql.begin(async (transaction) => {
      const locked = await transaction<SessionDeliveryRow[]>`
        SELECT *
        FROM session_deliveries
        WHERE delivery_id = ${deliveryId}
          AND state = 'pending'
          AND supervisor_role = ${supervisorRole}
        FOR UPDATE
      `;
      if (!locked[0]) return null;
      const targets = await transaction<Array<{ active_session_id: string }>>`
        SELECT registry.active_session_id
        FROM supervisor_registry AS registry
        JOIN sessions AS target
          ON target.session_id = registry.active_session_id
        WHERE registry.role = ${supervisorRole}
          AND registry.active_session_id IS NOT NULL
        FOR KEY SHARE OF registry
      `;
      const target = targets[0]?.active_session_id;
      if (!target) return null;
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET
          target_session_id = ${target},
          state = 'claimed',
          claimed_at = NOW(),
          lease_owner = ${leaseOwner},
          lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'pending'
        RETURNING *
      `;
      return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
    });
  }

  async beginDispatch(
    deliveryId: string,
    leaseOwner?: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries AS delivery
      SET state = 'dispatching', dispatching_at = NOW(), updated_at = NOW()
      WHERE delivery.delivery_id = ${deliveryId}
        AND delivery.state = 'claimed'
        AND (${leaseOwner ?? null}::text IS NULL OR delivery.lease_owner = ${leaseOwner ?? null})
        AND (
          delivery.lease_expires_at IS NULL
          OR delivery.lease_expires_at > NOW()
        )
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

  async claimRecoverableCompletionDeliveries(
    leaseOwner: string,
    limit = 100,
    leaseMs = 15_000,
  ): Promise<SessionDeliveryRow[]> {
    return await this.sql.begin(async (transaction) => {
      const due = await transaction<SessionDeliveryRow[]>`
        SELECT delivery.*
        FROM session_deliveries AS delivery
        WHERE (
            (
              delivery.intent = 'completion_notification'
              AND delivery.source = 'completion_notifier'
            )
            OR (
              delivery.intent = 'runtime_followup'
              AND delivery.source = 'claude_runtime_task_followup'
            )
          )
          AND delivery.state = 'pending'
          AND delivery.next_attempt_at <= NOW()
        ORDER BY delivery.next_attempt_at, delivery.created_at, delivery.delivery_id
        FOR UPDATE OF delivery SKIP LOCKED
        LIMIT ${limit}
      `;
      const claimed: SessionDeliveryRow[] = [];
      for (const row of due) {
        let targetSessionId = row.target_session_id;
        if (row.supervisor_role) {
          const targets = await transaction<Array<{ active_session_id: string }>>`
            SELECT registry.active_session_id
            FROM supervisor_registry AS registry
            JOIN sessions AS target
              ON target.session_id = registry.active_session_id
            WHERE registry.role = ${row.supervisor_role}
              AND registry.active_session_id IS NOT NULL
            FOR KEY SHARE OF registry
          `;
          targetSessionId = targets[0]?.active_session_id ?? null;
        } else if (targetSessionId) {
          const targets = await transaction<Array<{ session_id: string }>>`
            SELECT session_id FROM sessions
            WHERE session_id = ${targetSessionId}
          `;
          targetSessionId = targets[0]?.session_id ?? null;
        }
        if (!targetSessionId) {
          await transaction`
            UPDATE session_deliveries
            SET
              target_session_id = CASE
                WHEN supervisor_role IS NULL THEN target_session_id
                ELSE NULL
              END,
              attempt_count = attempt_count + 1,
              next_attempt_at = NOW()
                + LEAST(
                    INTERVAL '60 seconds',
                    INTERVAL '100 milliseconds'
                      * POWER(2, LEAST(attempt_count, 9))
                  ),
              last_error = 'no_current_target',
              updated_at = NOW()
            WHERE delivery_id = ${row.delivery_id}
              AND state = 'pending'
          `;
          continue;
        }
        const updated = await transaction<SessionDeliveryRow[]>`
          UPDATE session_deliveries
          SET
            target_session_id = ${targetSessionId},
            state = 'claimed',
            claimed_at = NOW(),
            lease_owner = ${leaseOwner},
            lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
            updated_at = NOW()
          WHERE delivery_id = ${row.delivery_id}
            AND state = 'pending'
          RETURNING *
        `;
        if (updated[0]) claimed.push(normalizeDeliveryRow(updated[0]));
      }
      return claimed;
    });
  }

  async deferPending(
    deliveryId: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        target_session_id = CASE
          WHEN supervisor_role IS NULL THEN target_session_id
          ELSE NULL
        END,
        attempt_count = attempt_count + 1,
        next_attempt_at = ${nextAttemptAt},
        last_error = ${error},
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND state = 'pending'
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async retryLeasedDelivery(
    deliveryId: string,
    leaseOwner: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'pending',
        target_session_id = CASE
          WHEN supervisor_role IS NULL THEN target_session_id
          ELSE NULL
        END,
        lease_owner = NULL,
        lease_expires_at = NULL,
        attempt_count = attempt_count + 1,
        next_attempt_at = ${nextAttemptAt},
        last_error = ${error},
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND lease_owner = ${leaseOwner}
        AND state IN ('claimed', 'dispatching')
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async releaseExpiredDeliveryLeases(): Promise<number> {
    const rows = await this.sql<Array<{ delivery_id: string }>>`
      UPDATE session_deliveries
      SET
        state = 'pending',
        target_session_id = CASE
          WHEN supervisor_role IS NULL THEN target_session_id
          ELSE NULL
        END,
        lease_owner = NULL,
        lease_expires_at = NULL,
        attempt_count = attempt_count + 1,
        next_attempt_at = NOW()
          + LEAST(
              INTERVAL '60 seconds',
              INTERVAL '100 milliseconds'
                * POWER(2, LEAST(attempt_count, 9))
            ),
        last_error = COALESCE(last_error, 'delivery lease expired'),
        updated_at = NOW()
      WHERE state IN ('claimed', 'dispatching')
        AND lease_expires_at <= NOW()
      RETURNING delivery_id
    `;
    return rows.length;
  }

  async markQueued(
    deliveryId: string,
    leaseOwner?: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET state = 'queued', queued_at = NOW(), updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND state = 'dispatching'
        AND (${leaseOwner ?? null}::text IS NULL OR lease_owner = ${leaseOwner ?? null})
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
