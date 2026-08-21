import type {
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";
import { appendSessionDeliveryAttempt } from
  "./session_delivery_attempt_repository.js";
import {
  attemptOutcomeFor,
  deliveryRetryOrDeadLetterSet,
} from "./session_delivery_retry_policy.js";

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

  async claimRecoverableCompletionDeliveries(
    leaseOwner: string,
    limit = 100,
    leaseMs = 15_000,
  ): Promise<SessionDeliveryRow[]> {
    return await withRecoveryTransaction(this.sql, async (transaction) => {
      await transaction`
        UPDATE session_deliveries AS delivery
        SET
          state = 'consumed',
          aggregate_state = 'consumed',
          caller_turn_id = consumption.consumed_turn_id,
          consumed_at = consumption.consumed_at,
          consumed_reason = 'exact relation receipt recovery',
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
        FROM session_delivery_relation_consumptions AS consumption
        WHERE delivery.relation_key = consumption.relation_key
          AND delivery.completion_id = consumption.completion_id
          AND delivery.target_session_id = consumption.caller_session_id
          AND delivery.intent = 'completion_notification'
          AND delivery.aggregate_state = 'delivered'
          AND delivery.state IN ('delivered', 'queued')
          AND delivery.target_receipt_id IS NOT NULL
      `;
      await transaction`
        WITH ranked AS (
          SELECT delivery_id,
            ROW_NUMBER() OVER (
              PARTITION BY target_session_id, payload->>'followup_key'
              ORDER BY
                CASE WHEN jsonb_typeof(payload->'followup_attempt') = 'number'
                  THEN (payload->>'followup_attempt')::integer ELSE 1 END DESC,
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
        SET state = 'superseded', aggregate_state = 'consumed',
            consumed_at = NOW(),
            consumed_reason = 'superseded by newer runtime follow-up',
            superseded_at = NOW(), updated_at = NOW()
        FROM ranked
        WHERE delivery.delivery_id = ranked.delivery_id
          AND ranked.followup_rank > 1
          AND delivery.state = 'pending'
      `;
      const due = await transaction<SessionDeliveryRow[]>`
        SELECT delivery.*
        FROM session_deliveries AS delivery
        WHERE (
          (delivery.intent = 'completion_notification'
            AND delivery.source = 'completion_notifier')
          OR (delivery.intent = 'runtime_followup'
            AND delivery.source = 'claude_runtime_task_followup')
          OR delivery.intent = 'durable_next_turn'
        )
          AND delivery.state = 'pending'
          AND delivery.next_attempt_at <= NOW()
        ORDER BY delivery.next_attempt_at, delivery.created_at, delivery.enqueue_sequence
        FOR UPDATE OF delivery SKIP LOCKED
        LIMIT ${limit}
      `;
      const claimed: SessionDeliveryRow[] = [];
      for (const row of due) {
        let targetSessionId = row.target_session_id;
        if (targetSessionId) {
          const targets = await transaction<Array<{ session_id: string }>>`
            SELECT session_id FROM sessions WHERE session_id = ${targetSessionId}
          `;
          targetSessionId = targets[0]?.session_id ?? null;
        }
        if (!targetSessionId) {
          const deferred = await transaction<Array<
            Pick<SessionDeliveryRow, "aggregate_state">
          >>`
            UPDATE session_deliveries
            SET ${deliveryRetryOrDeadLetterSet(transaction as unknown as SqlClient, {
              reason: "no_current_target",
              retryState: "pending",
            })}
            WHERE delivery_id = ${row.delivery_id} AND state = 'pending'
            RETURNING aggregate_state
          `;
          await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
            deliveryId: row.delivery_id,
            outcome: deferred[0]
              ? attemptOutcomeFor(deferred[0])
              : "retryable",
            reason: "no_current_target",
          });
          continue;
        }
        const updated = await transaction<SessionDeliveryRow[]>`
          UPDATE session_deliveries
          SET target_session_id = ${targetSessionId}, state = 'claimed',
              claimed_at = NOW(), lease_owner = ${leaseOwner},
              lease_expires_at = NOW() + (${leaseMs}::double precision * INTERVAL '1 millisecond'),
              updated_at = NOW()
          WHERE delivery_id = ${row.delivery_id} AND state = 'pending'
          RETURNING *
        `;
        if (updated[0]) claimed.push(updated[0]);
      }
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
          delivered_at = NOW(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = 'worker_restart_transcript_reconciled',
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'claimed'
          AND lease_owner = ${leaseOwner}
        RETURNING *
      `;
      return rows[0] ?? null;
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
        SET ${deliveryRetryOrDeadLetterSet(transaction as unknown as SqlClient, {
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
      // Probes stay out of the attempt ledger unless one of them ends the
      // delivery; a one-second poll would otherwise bury the real attempts.
      if (row.aggregate_state === "dead_letter") {
        await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
          deliveryId,
          outcome: attemptOutcomeFor(row),
          reason: error,
          leaseOwner,
        });
      }
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
            'durable_next_turn', 'completion_notification', 'runtime_followup'
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
