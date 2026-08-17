import type {
  RecordObservedChildCompletionBatchResult,
  RecordObservedChildCompletionParams,
  RecordObservedChildCompletionResult,
  RecordSessionDeliveryRelationConsumptionParams,
  RecordSessionDeliveryRelationConsumptionResult,
  RegisterSessionDeliveryParams,
  RegisterSessionDeliveryResult,
  SessionDeliveryRelationConsumptionRow,
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";
import { SessionDeliveryNotificationRepository } from "./session_delivery_notification_repository.js";
import { SessionDeliveryRecoveryRepository } from
  "./session_delivery_recovery_repository.js";
import {
  getSessionDeliveryRelationConsumption,
  recordObservedChildCompletion,
  recordObservedChildCompletions,
  recordSessionDeliveryRelationConsumed,
  registerSessionDelivery,
} from "./session_delivery_relation_repository.js";

export class SessionDeliveryRepository {
  readonly notifications: SessionDeliveryNotificationRepository;
  readonly recovery: SessionDeliveryRecoveryRepository;

  constructor(private readonly sql: SqlClient) {
    this.notifications = new SessionDeliveryNotificationRepository(sql);
    this.recovery = new SessionDeliveryRecoveryRepository(sql);
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

  async recordObservedChildCompletion(
    params: RecordObservedChildCompletionParams,
  ): Promise<RecordObservedChildCompletionResult> {
    return await recordObservedChildCompletion(this.sql, params);
  }

  async recordObservedChildCompletions(
    params: RecordObservedChildCompletionParams[],
  ): Promise<RecordObservedChildCompletionBatchResult> {
    return await recordObservedChildCompletions(this.sql, params);
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
          delivery.intent <> 'completion_notification'
          OR delivery.source <> 'completion_notifier'
          OR EXISTS (
            SELECT 1
            FROM sessions AS source_session
            WHERE source_session.session_id = delivery.source_session_id
              AND source_session.status IN ('completed', 'error', 'interrupted')
              AND source_session.termination_event_id IS NOT NULL
              AND source_session.termination_event_id::text
                = delivery.producer_terminal_revision
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
      // Recovery is another admission boundary. Collapse only pending siblings
      // before any row is claimed; already-claimed work remains immutable.
      await transaction`
        WITH ranked AS (
          SELECT
            delivery_id,
            ROW_NUMBER() OVER (
              PARTITION BY target_session_id, payload->>'followup_key'
              ORDER BY
                CASE
                  WHEN jsonb_typeof(payload->'followup_attempt') = 'number'
                    THEN (payload->>'followup_attempt')::integer
                  ELSE 1
                END DESC,
                created_at DESC,
                enqueue_sequence DESC
            ) AS followup_rank
          FROM session_deliveries
          WHERE intent = 'runtime_followup'
            AND source = 'claude_runtime_task_followup'
            AND state = 'pending'
            AND payload->>'followup_key' IS NOT NULL
        )
        UPDATE session_deliveries AS delivery
        SET
          state = 'superseded',
          superseded_at = NOW(),
          updated_at = NOW()
        FROM ranked
        WHERE delivery.delivery_id = ranked.delivery_id
          AND ranked.followup_rank > 1
          AND delivery.state = 'pending'
      `;
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
        ORDER BY
          delivery.next_attempt_at,
          delivery.created_at,
          delivery.enqueue_sequence
        FOR UPDATE OF delivery SKIP LOCKED
        LIMIT ${limit}
      `;
      const claimed: SessionDeliveryRow[] = [];
      for (const row of due) {
        let targetSessionId = row.target_session_id;
        if (targetSessionId) {
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

  async markPendingSuperseded(
    deliveryId: string,
    supersededTerminalRevision: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'superseded',
        superseded_at = NOW(),
        superseded_terminal_revision = ${supersededTerminalRevision},
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND state = 'pending'
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async releaseExpiredDeliveryLeases(): Promise<number> {
    const rows = await this.sql<Array<{ delivery_id: string }>>`
      UPDATE session_deliveries
      SET
        state = 'pending',
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

  async markUncertain(
    deliveryId: string,
    leaseOwner?: string,
    error?: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'uncertain',
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = COALESCE(${error ?? null}, last_error),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND state NOT IN ('consumed', 'superseded')
        AND (
          ${leaseOwner ?? null}::text IS NULL
          OR (lease_owner = ${leaseOwner ?? null} AND state IN ('claimed', 'dispatching'))
        )
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

}
function normalizeDeliveryRow(row: SessionDeliveryRow): SessionDeliveryRow {
  return row;
}
