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
import { appendSessionDeliveryAttempt } from
  "./session_delivery_attempt_repository.js";
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
    return await this.recovery.claimRecoverableCompletionDeliveries(
      leaseOwner,
      limit,
      leaseMs,
    );
  }

  async deferPending(
    deliveryId: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET
          aggregate_state = 'pending',
          attempt_count = attempt_count + 1,
          next_attempt_at = ${nextAttemptAt},
          last_error = ${error},
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'pending'
        RETURNING *
      `;
      const row = rows[0];
      if (!row) return null;
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId,
        outcome: "retryable",
        reason: error,
      });
      return normalizeDeliveryRow(row);
    });
  }

  async retryLeasedDelivery(
    deliveryId: string,
    leaseOwner: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET
          state = 'pending',
          aggregate_state = 'pending',
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
      const row = rows[0];
      if (!row) return null;
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId,
        outcome: "retryable",
        reason: error,
        leaseOwner,
      });
      return normalizeDeliveryRow(row);
    });
  }

  async markPendingSuperseded(
    deliveryId: string,
    supersededTerminalRevision: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'superseded',
        aggregate_state = 'consumed',
        consumed_reason = ${supersededTerminalRevision},
        consumed_at = NOW(),
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
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<Array<{ delivery_id: string; lease_owner: string | null }>>`
        UPDATE session_deliveries
        SET
          state = 'pending', aggregate_state = 'pending',
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
        RETURNING delivery_id, lease_owner
      `;
      for (const row of rows) {
        await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
          deliveryId: row.delivery_id,
          outcome: "retryable",
          reason: "delivery lease expired",
          leaseOwner: row.lease_owner,
        });
      }
      return rows.length;
    });
  }

  async markQueued(
    deliveryId: string,
    leaseOwner?: string,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET state = 'queued', aggregate_state = 'pending',
            queued_at = NOW(), updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'dispatching'
          AND (${leaseOwner ?? null}::text IS NULL OR lease_owner = ${leaseOwner ?? null})
        RETURNING *
      `;
      const row = rows[0];
      if (!row) return null;
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId,
        outcome: "accepted",
        reason: "durable local admission",
        leaseOwner: row.lease_owner,
      });
      return normalizeDeliveryRow(row);
    });
  }

  async markDelivered(
    deliveryId: string,
    callerTurnId: string,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'delivered',
        aggregate_state = 'delivered',
        caller_turn_id = ${callerTurnId},
        target_receipt_id = ${callerTurnId},
        target_receipt_at = NOW(),
        delivered_at = NOW(),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND aggregate_state = 'pending'
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
        aggregate_state = 'consumed',
        caller_turn_id = COALESCE(${callerTurnId ?? null}, caller_turn_id),
        consumed_at = NOW(),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND aggregate_state = 'delivered'
        AND target_receipt_id = ${callerTurnId ?? null}
        AND state IN ('delivered', 'queued')
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
        aggregate_state = 'consumed',
        caller_turn_id = ${callerTurnId},
        target_receipt_id = COALESCE(target_receipt_id, ${callerTurnId}),
        target_receipt_at = COALESCE(target_receipt_at, NOW()),
        consumed_at = NOW(),
        updated_at = NOW()
      WHERE relation_key = ${relationKey}
        AND completion_id = ${completionId}
        AND aggregate_state IN ('pending', 'delivered')
        AND state IN ('pending', 'claimed', 'delivered')
      RETURNING *
    `;
    return rows[0] ? normalizeDeliveryRow(rows[0]) : null;
  }

  async markUncertain(
    deliveryId: string,
    leaseOwner?: string,
    error?: string,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const reason = error ?? "delivery result rejected";
      const rows = await transaction<Array<SessionDeliveryRow & {
        attempt_lease_owner: string | null;
      }>>`
        WITH candidate AS MATERIALIZED (
          SELECT delivery_id, lease_owner AS attempt_lease_owner
          FROM session_deliveries
          WHERE delivery_id = ${deliveryId}
            AND aggregate_state NOT IN ('consumed', 'dead_letter')
            AND state NOT IN ('consumed', 'superseded')
            AND (
              ${leaseOwner ?? null}::text IS NULL
              OR (lease_owner = ${leaseOwner ?? null} AND state IN ('claimed', 'dispatching'))
            )
          FOR UPDATE
        )
        UPDATE session_deliveries AS delivery
        SET
          state = 'uncertain',
          aggregate_state = 'dead_letter',
          lease_owner = NULL,
          lease_expires_at = NULL,
          attempt_count = delivery.attempt_count + 1,
          last_error = ${reason},
          dead_letter_reason = ${reason},
          dead_lettered_at = NOW(),
          updated_at = NOW()
        FROM candidate
        WHERE delivery.delivery_id = candidate.delivery_id
        RETURNING delivery.*, candidate.attempt_lease_owner
      `;
      const row = rows[0];
      if (!row) return null;
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId,
        outcome: "rejected",
        reason,
        leaseOwner: row.attempt_lease_owner,
      });
      return normalizeDeliveryRow(row);
    });
  }

}

function normalizeDeliveryRow(row: SessionDeliveryRow): SessionDeliveryRow {
  return row;
}

async function withDeliveryTransaction<T>(
  sql: SqlClient,
  operation: (transaction: SqlClient) => Promise<T>,
): Promise<T> {
  const begin = (sql as SqlClient & {
    begin?: (callback: (transaction: SqlClient) => Promise<T>) => Promise<T>;
  }).begin;
  return begin
    ? await begin.call(sql, operation)
    : await operation(sql);
}
