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
import { deliveryRetrySet } from "./session_delivery_retry_policy.js";
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
        lease_expires_at = NOW() + (${leaseMs}::double precision * INTERVAL '1 millisecond'),
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
        lease_expires_at = NOW() + (${leaseMs}::double precision * INTERVAL '1 millisecond'),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND state IN ('pending', 'queued')
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
    deliveryId?: string,
  ): Promise<SessionDeliveryRow[]> {
    return await this.recovery.claimRecoverableCompletionDeliveries(
      leaseOwner,
      limit,
      leaseMs,
      deliveryId,
    );
  }

  async deferPending(
    deliveryId: string,
    error: string,
    retryDelayMs: number,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET ${deliveryRetrySet(transaction as unknown as SqlClient, {
          reason: error,
          retryState: "pending",
          retryDelayMs,
        })}
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
    retryDelayMs: number,
  ): Promise<SessionDeliveryRow | null> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET ${deliveryRetrySet(transaction as unknown as SqlClient, {
          reason: error,
          retryState: "pending",
          retryDelayMs,
        })}
        WHERE delivery_id = ${deliveryId}
          AND lease_owner = ${leaseOwner}
          AND state IN ('claimed', 'dispatching', 'queued')
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

  async releaseExpiredDeliveryLeases(): Promise<number> {
    return await withDeliveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<Array<{
        delivery_id: string;
        lease_owner: string | null;
        aggregate_state: SessionDeliveryRow["aggregate_state"];
      }>>`
        UPDATE session_deliveries
        SET ${deliveryRetrySet(transaction as unknown as SqlClient, {
          reason: "delivery lease expired",
          retryState: "pending",
          preserveExistingError: true,
        })}
        WHERE state IN ('claimed', 'dispatching')
          AND lease_expires_at <= NOW()
        RETURNING delivery_id, lease_owner, aggregate_state
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

  async markConsumedByRelation(
    params: RecordSessionDeliveryRelationConsumptionParams,
  ): Promise<RecordSessionDeliveryRelationConsumptionResult> {
    return await recordSessionDeliveryRelationConsumed(this.sql, params);
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
