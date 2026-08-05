import type {
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";

export interface QueuedDeliveryRecoveryScan {
  recoveryNodeId: string;
  staleNodeBefore: Date;
  queuedBefore: Date;
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
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'delivered',
        caller_turn_id = ${`transcript:${assistantMessageUuid}`},
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
  }

  async deferQueuedTranscriptCheck(
    deliveryId: string,
    leaseOwner: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<SessionDeliveryRow | null> {
    const rows = await this.sql<SessionDeliveryRow[]>`
      UPDATE session_deliveries
      SET
        state = 'queued',
        lease_owner = NULL,
        lease_expires_at = NULL,
        attempt_count = attempt_count + 1,
        next_attempt_at = ${nextAttemptAt},
        last_error = ${error},
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND state = 'claimed'
        AND lease_owner = ${leaseOwner}
      RETURNING *
    `;
    return rows[0] ?? null;
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
          AND delivery.intent IN ('completion_notification', 'runtime_followup')
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
                    AND heartbeat.last_seen_at < ${scan?.staleNodeBefore ?? null}
                )
                OR delivery.queued_at <= ${scan?.queuedBefore ?? null}
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
        lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
        updated_at = NOW()
      FROM recoverable
      WHERE delivery.delivery_id = recoverable.delivery_id
        AND delivery.state = 'queued'
      RETURNING delivery.*
    `;
    return rows;
  }
}
