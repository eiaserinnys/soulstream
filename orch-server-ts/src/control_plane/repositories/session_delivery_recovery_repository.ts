import type {
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";
import { deliveryRetrySet } from "./session_delivery_retry_policy.js";
import { recordSessionDeliveryRelationConsumed } from
  "./session_delivery_relation_repository.js";

export interface QueuedDeliveryRecoveryScan {
  recoveryNodeId: string;
  /**
   * How long a node's heartbeat may lag before its sessions count as dead.
   *
   * A duration, not an instant: `last_seen_at` and this bound used to come
   * from two different node clocks with no database term between them, so a
   * 7.45s skew shrank the threshold and let a live node's queued deliveries be
   * claimed by another node (260820 incident).
   */
  staleNodeAfterMs: number;
  /** How long a delivery may sit queued before any node may recover it. */
  queuedAfterMs: number;
}
/**
 * Owns the short recovery lease used while a worker checks the Claude
 * transcript for a previously queued delivery.
 *
 * Transcript I/O cannot run inside a PostgreSQL transaction. Moving queued
 * rows to a leased `claimed` state first prevents two recovery workers from
 * independently deciding to replay the same SDK input.
 */
export class SessionDeliveryRecoveryRepository {
  constructor(private readonly sql: SqlClient) {}

  async claimPendingImmediateIntentsForNode(
    nodeId: string,
    leaseOwner: string,
    limit = 100,
    leaseMs = 15_000,
  ): Promise<SessionDeliveryRow[]> {
    return await withRecoveryTransaction(this.sql, async (transaction) => {
      return await transaction<SessionDeliveryRow[]>`
        WITH due AS MATERIALIZED (
          SELECT delivery.delivery_id
          FROM session_deliveries AS delivery
          JOIN sessions AS target
            ON target.session_id = delivery.target_session_id
          WHERE target.node_id = ${nodeId}
            AND delivery.intent IN ('human_live_steer', 'runtime_followup')
            AND delivery.state = 'pending'
            AND delivery.next_attempt_at <= NOW()
          ORDER BY delivery.enqueue_sequence
          FOR UPDATE OF delivery SKIP LOCKED
          LIMIT ${limit}
        ), claimed AS (
          UPDATE session_deliveries AS delivery
          SET
            state = 'claimed',
            claimed_at = NOW(),
            lease_owner = ${leaseOwner},
            lease_expires_at = NOW()
              + (${leaseMs}::double precision * INTERVAL '1 millisecond'),
            updated_at = NOW()
          FROM due
          WHERE delivery.delivery_id = due.delivery_id
            AND delivery.state = 'pending'
          RETURNING delivery.*
        )
        SELECT claimed.*
        FROM claimed
        ORDER BY claimed.enqueue_sequence
      `;
    });
  }

  async claimRecoverableCompletionDeliveries(
    leaseOwner: string,
    limit = 100,
    leaseMs = 15_000,
    deliveryId?: string,
  ): Promise<SessionDeliveryRow[]> {
    return await withRecoveryTransaction(this.sql, async (transaction) => {
      const claimed = await transaction<SessionDeliveryRow[]>`
        WITH due AS MATERIALIZED (
          SELECT delivery.delivery_id
          FROM session_deliveries AS delivery
          JOIN sessions AS target
            ON target.session_id = delivery.target_session_id
          WHERE (${deliveryId ?? null}::text IS NULL
              OR delivery.delivery_id = ${deliveryId ?? null}::text)
            AND delivery.intent = 'completion_notification'
            AND delivery.source = 'completion_notifier'
            AND delivery.state = 'pending'
            AND delivery.next_attempt_at <= NOW()
          ORDER BY delivery.next_attempt_at, delivery.created_at,
            delivery.enqueue_sequence
          FOR UPDATE OF delivery SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE session_deliveries AS delivery
        SET state = 'claimed', claimed_at = NOW(), lease_owner = ${leaseOwner},
            lease_expires_at = NOW()
              + (${leaseMs}::double precision * INTERVAL '1 millisecond'),
            updated_at = NOW()
        FROM due
        WHERE delivery.delivery_id = due.delivery_id
          AND delivery.state = 'pending'
        RETURNING delivery.*
      `;
      return claimed;
    });
  }

  async claimQueuedAfterNodeRestart(
    nodeId: string,
    leaseOwner: string,
    limit = 100,
    leaseMs = 15_000,
  ): Promise<SessionDeliveryRow[]> {
    return await this.claimQueued(
      leaseOwner,
      limit,
      leaseMs,
      { startupNodeId: nodeId },
    );
  }

  async claimRecoverableQueued(
    scan: QueuedDeliveryRecoveryScan,
    leaseOwner: string,
    limit = 100,
    leaseMs = 15_000,
  ): Promise<SessionDeliveryRow[]> {
    return await this.claimQueued(
      leaseOwner,
      limit,
      leaseMs,
      { scan },
    );
  }

  async markDeliveredFromTranscript(
    deliveryId: string,
    leaseOwner: string,
    assistantMessageUuid: string,
  ): Promise<SessionDeliveryRow | null> {
    return await withRecoveryTransaction(this.sql, async (transaction) => {
      const receiptId = `transcript:${assistantMessageUuid}`;
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET
          state = 'delivered', aggregate_state = 'delivered',
          caller_turn_id = ${receiptId},
          target_receipt_id = ${receiptId}, target_receipt_at = NOW(),
          delivered_at = COALESCE(delivered_at, NOW()),
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = 'worker_restart_transcript_reconciled',
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'claimed'
          AND lease_owner = ${leaseOwner}
        RETURNING *
      `;
      const delivered = rows[0] ?? null;
      if (!delivered) return null;
      if (!delivered.completion_id || !delivered.target_session_id) {
        throw new Error(
          `Transcript-proven delivery ${deliveryId} lacks relation identity`,
        );
      }
      const result = await recordSessionDeliveryRelationConsumed(
        transaction as unknown as SqlClient,
        {
          deliveryId,
          relationKey: delivered.relation_key,
          completionId: delivered.completion_id,
          callerSessionId: delivered.target_session_id,
          consumedTurnId: receiptId,
        },
      );
      if (!result.deliveryConsumed) {
        throw new Error(`Transcript-proven delivery ${deliveryId} did not reach consumed`);
      }
      const consumedRows = await transaction<SessionDeliveryRow[]>`
        SELECT * FROM session_deliveries WHERE delivery_id = ${deliveryId}
      `;
      return consumedRows[0] ?? null;
    });
  }

  async deferQueuedTranscriptCheck(
    deliveryId: string,
    leaseOwner: string,
    error: string,
    retryDelayMs: number,
  ): Promise<SessionDeliveryRow | null> {
    return await withRecoveryTransaction(this.sql, async (transaction) => {
      const rows = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET ${deliveryRetrySet(transaction as unknown as SqlClient, {
          reason: error,
          retryState: "queued",
          retryDelayMs,
          // Re-checking whether a transcript has settled is a liveness probe,
          // not a delivery attempt.
          spendsAttempt: false,
        })}
        WHERE delivery_id = ${deliveryId}
          AND state = 'claimed'
          AND lease_owner = ${leaseOwner}
        RETURNING *
      `;
      const row = rows[0];
      if (!row) return null;
      return row;
    });
  }

  private async claimQueued(
    leaseOwner: string,
    limit: number,
    leaseMs: number,
    mode: {
      startupNodeId?: string;
      scan?: QueuedDeliveryRecoveryScan;
    },
  ): Promise<SessionDeliveryRow[]> {
    const startupNodeId = mode.startupNodeId ?? null;
    const scan = mode.scan;
    const rows = await this.sql<SessionDeliveryRow[]>`
      WITH recoverable AS MATERIALIZED (
        SELECT delivery.delivery_id
        FROM session_deliveries AS delivery
        WHERE delivery.state = 'queued'
          AND delivery.intent IN (
            'human_live_steer', 'durable_next_turn',
            'completion_notification', 'runtime_followup'
          )
          AND delivery.next_attempt_at <= NOW()
          AND (
            (
              ${startupNodeId}::text IS NOT NULL
              AND (
                delivery.target_session_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM sessions AS target
                  WHERE target.session_id = delivery.target_session_id
                    AND target.node_id = ${startupNodeId}
                )
              )
            )
            OR (
              ${startupNodeId}::text IS NULL
              AND (
                delivery.target_session_id IS NULL
                OR NOT EXISTS (
                  SELECT 1
                  FROM sessions AS target
                  WHERE target.session_id = delivery.target_session_id
                )
                OR EXISTS (
                  SELECT 1
                  FROM sessions AS target
                  JOIN soulstream_node_heartbeats AS heartbeat
                    ON heartbeat.node_id = target.node_id
                  WHERE target.session_id = delivery.target_session_id
                    AND heartbeat.last_seen_at < NOW()
                      - (${scan?.staleNodeAfterMs ?? null}::double precision * INTERVAL '1 millisecond')
                )
                OR delivery.queued_at <= NOW()
                  - (${scan?.queuedAfterMs ?? null}::double precision * INTERVAL '1 millisecond')
              )
            )
          )
        ORDER BY delivery.next_attempt_at, delivery.queued_at, delivery.delivery_id
        FOR UPDATE OF delivery SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE session_deliveries AS delivery
      SET
        state = 'claimed',
        lease_owner = ${leaseOwner},
        lease_expires_at = NOW() + (${leaseMs}::double precision * INTERVAL '1 millisecond'),
        updated_at = NOW()
      FROM recoverable
      WHERE delivery.delivery_id = recoverable.delivery_id
        AND delivery.state = 'queued'
      RETURNING delivery.*
    `;
    return rows;
  }
}

async function withRecoveryTransaction<T>(
  sql: SqlClient,
  operation: (transaction: SqlClient) => Promise<T>,
): Promise<T> {
  const begin = (sql as SqlClient & {
    begin?: (callback: (transaction: SqlClient) => Promise<T>) => Promise<T>;
  }).begin;
  return begin ? await begin.call(sql, operation) : await operation(sql);
}
