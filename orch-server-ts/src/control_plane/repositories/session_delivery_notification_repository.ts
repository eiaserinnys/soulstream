import type {
  SessionDeliveryNotificationOutboxRow,
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";
import { asPostgresJsonValue } from "../repository_helpers.js";
import { appendSessionDeliveryAttempt } from
  "./session_delivery_attempt_repository.js";
import { validateNotificationPayload } from
  "./session_delivery_notification_payload.js";
import {
  lockSessionDeliveries,
  lockSessionDelivery,
} from "./session_delivery_notification_projection_repository.js";

const DEFAULT_NOTIFICATION_ATTEMPT_TTL_MS = 15_000;

export class SessionDeliveryNotificationRepository {
  constructor(private readonly sql: SqlClient) {}

  async get(
    deliveryId: string,
  ): Promise<SessionDeliveryNotificationOutboxRow | null> {
    const rows = await this.sql<SessionDeliveryNotificationOutboxRow[]>`
      SELECT *
      FROM session_delivery_notification_outbox
      WHERE delivery_id = ${deliveryId}
    `;
    return rows[0] ?? null;
  }

  async stageWithQueuedDelivery(params: {
    deliveryId: string;
    attemptToken: string;
    targetSessionId: string;
    disposition: "queued" | "auto_resume";
    payload: Record<string, unknown>;
  }, attemptTtlMs = DEFAULT_NOTIFICATION_ATTEMPT_TTL_MS): Promise<SessionDeliveryRow | null> {
    const payload = validateNotificationPayload(params);
    return await this.sql.begin(async (transaction) => {
      const advanced = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET state = 'queued', aggregate_state = 'pending',
            queued_at = NOW(), updated_at = NOW()
        WHERE delivery_id = ${params.deliveryId}
          AND state = 'dispatching'
          AND attempt_token = ${params.attemptToken}
        RETURNING *
      `;
      const row = advanced[0];
      if (!row) return null;
      const stagedOutbox = await transaction<Array<{ delivery_id: string }>>`
        INSERT INTO session_delivery_notification_outbox (
          delivery_id,
          target_session_id,
          payload,
          disposition,
          state,
          projection_state,
          attempt_token,
          attempt_expires_at,
          next_attempt_at,
          created_at,
          updated_at
        ) VALUES (
          ${params.deliveryId},
          ${params.targetSessionId},
          ${transaction.json(asPostgresJsonValue(payload))},
          ${params.disposition},
          'claimed',
          'publishing',
          ${params.attemptToken},
          NOW() + (${attemptTtlMs}::double precision * INTERVAL '1 millisecond'),
          NOW(),
          NOW(),
          NOW()
        )
        ON CONFLICT (delivery_id) DO UPDATE
        SET
          target_session_id = EXCLUDED.target_session_id,
          payload = EXCLUDED.payload,
          disposition = EXCLUDED.disposition,
          state = 'claimed',
          projection_state = 'publishing',
          attempt_token = EXCLUDED.attempt_token,
          attempt_expires_at = EXCLUDED.attempt_expires_at,
          next_attempt_at = NOW(),
          last_error = NULL,
          updated_at = NOW()
        WHERE
          session_delivery_notification_outbox.payload->>'delivery_id'
            = EXCLUDED.payload->>'delivery_id'
          AND session_delivery_notification_outbox.payload->>'completion_id'
            = EXCLUDED.payload->>'completion_id'
          AND session_delivery_notification_outbox.payload->>'relation_key'
            = EXCLUDED.payload->>'relation_key'
          AND session_delivery_notification_outbox.payload->>'delivery_intent'
            = EXCLUDED.payload->>'delivery_intent'
          AND (
            (
              session_delivery_notification_outbox.state = 'pending'
              AND session_delivery_notification_outbox.attempt_token IS NULL
              AND session_delivery_notification_outbox.projection_state
                IN ('staged', 'publishing')
            )
            OR (
              session_delivery_notification_outbox.state = 'claimed'
              AND session_delivery_notification_outbox.projection_state = 'publishing'
              AND (
                session_delivery_notification_outbox.attempt_token = EXCLUDED.attempt_token
                OR session_delivery_notification_outbox.attempt_expires_at <= NOW()
              )
            )
          )
        RETURNING delivery_id
      `;
      if (!stagedOutbox[0]) {
        throw new Error(`notification outbox already exists: ${params.deliveryId}`);
      }
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId: params.deliveryId,
        outcome: "accepted",
        reason: "durable notification admission",
        attemptToken: params.attemptToken,
      });
      return row;
    });
  }

  async claimDue(
    targetNodeId: string,
    attemptToken: string,
    limit = 100,
    attemptTtlMs = DEFAULT_NOTIFICATION_ATTEMPT_TTL_MS,
  ): Promise<SessionDeliveryNotificationOutboxRow[]> {
    return await this.sql.begin(async (transaction) => {
      const rows = await transaction<SessionDeliveryNotificationOutboxRow[]>`
        WITH due AS MATERIALIZED (
          SELECT outbox.delivery_id
          FROM session_delivery_notification_outbox AS outbox
          JOIN sessions AS target
            ON target.session_id = outbox.target_session_id
           AND target.node_id = ${targetNodeId}
          WHERE (
              outbox.state = 'pending'
              OR (
                outbox.state = 'claimed'
                AND outbox.attempt_expires_at <= NOW()
              )
            )
            AND outbox.next_attempt_at <= NOW()
          ORDER BY outbox.next_attempt_at, outbox.created_at, outbox.delivery_id
          FOR UPDATE OF outbox SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE session_delivery_notification_outbox AS outbox
        SET
          state = 'claimed',
          projection_state = 'publishing',
          attempt_token = ${attemptToken},
          attempt_expires_at = NOW() + (${attemptTtlMs}::double precision * INTERVAL '1 millisecond'),
          updated_at = NOW()
        FROM due
        WHERE outbox.delivery_id = due.delivery_id
        RETURNING outbox.*
      `;
      return rows;
    });
  }

  async markPublished(
    deliveryId: string,
    attemptToken: string,
    targetReceiptId: string,
  ): Promise<SessionDeliveryNotificationOutboxRow | null> {
    if (!targetReceiptId) throw new Error("notification target receipt required");
    return await this.sql.begin(async (transaction) => {
      if (!await lockSessionDelivery(
        transaction as unknown as SqlClient,
        deliveryId,
      )) return null;
      const rows = await transaction<SessionDeliveryNotificationOutboxRow[]>`
        UPDATE session_delivery_notification_outbox
        SET
          state = 'published',
          projection_state = 'published',
          target_receipt_id = ${targetReceiptId},
          target_receipt_at = NOW(),
          attempt_token = NULL,
          attempt_expires_at = NULL,
          published_at = NOW(),
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'claimed'
          AND attempt_token = ${attemptToken}
        RETURNING *
      `;
      if (!rows[0]) return null;
      const deliveryRows = await transaction<Array<{ delivery_id: string }>>`
        UPDATE session_deliveries
        SET
          state = CASE
            WHEN aggregate_state = 'pending' THEN 'delivered'
            ELSE state
          END,
          aggregate_state = CASE
            WHEN aggregate_state = 'pending' THEN 'delivered'
            ELSE aggregate_state
          END,
          target_receipt_id = COALESCE(target_receipt_id, ${targetReceiptId}),
          target_receipt_at = COALESCE(target_receipt_at, NOW()),
          delivered_at = COALESCE(delivered_at, NOW()),
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND (
            aggregate_state = 'pending'
            OR (
              aggregate_state = 'delivered'
              AND target_receipt_id = ${targetReceiptId}
            )
          )
        RETURNING delivery_id
      `;
      if (!deliveryRows[0]) {
        throw new Error(`notification delivery receipt was not projected: ${deliveryId}`);
      }
      return rows[0];
    });
  }

  async retry(
    deliveryId: string,
    attemptToken: string,
    error: string,
    nextAttemptAt: Date,
    maxAttempts: number,
    oldestAllowedCreatedAt: Date,
  ): Promise<SessionDeliveryNotificationOutboxRow | null> {
    return await this.sql.begin(async (transaction) => {
      if (!await lockSessionDelivery(
        transaction as unknown as SqlClient,
        deliveryId,
      )) return null;
      const rows = await transaction<SessionDeliveryNotificationOutboxRow[]>`
        UPDATE session_delivery_notification_outbox
        SET
          state = CASE
            WHEN attempt_count + 1 >= ${maxAttempts}
              OR created_at <= ${oldestAllowedCreatedAt}
            THEN 'dead_letter'
            ELSE 'pending'
          END,
          projection_state = 'staged',
          attempt_token = NULL,
          attempt_expires_at = NULL,
          attempt_count = attempt_count + 1,
          next_attempt_at = ${nextAttemptAt},
          last_error = ${error},
          dead_lettered_at = CASE
            WHEN attempt_count + 1 >= ${maxAttempts}
              OR created_at <= ${oldestAllowedCreatedAt}
            THEN NOW()
            ELSE NULL
          END,
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'claimed'
          AND attempt_token = ${attemptToken}
        RETURNING *
      `;
      const row = rows[0];
      if (!row) return null;
      const rejected = row.state === "dead_letter";
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId,
        outcome: rejected ? "rejected" : "retryable",
        reason: error,
        attemptToken,
      });
      await transaction`
        UPDATE session_deliveries
        SET aggregate_state = ${rejected ? "dead_letter" : "pending"},
            dead_letter_reason = ${rejected ? error : null},
            dead_lettered_at = ${rejected ? new Date() : null},
            last_error = ${error}, updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND aggregate_state NOT IN ('consumed', 'dead_letter')
      `;
      return row;
    });
  }

  async deadLetter(
    deliveryId: string,
    attemptToken: string,
    error: string,
  ): Promise<SessionDeliveryNotificationOutboxRow | null> {
    return await this.sql.begin(async (transaction) => {
      if (!await lockSessionDelivery(
        transaction as unknown as SqlClient,
        deliveryId,
      )) return null;
      const rows = await transaction<SessionDeliveryNotificationOutboxRow[]>`
        UPDATE session_delivery_notification_outbox
        SET
          state = 'dead_letter',
          projection_state = 'staged',
          attempt_token = NULL,
          attempt_expires_at = NULL,
          last_error = ${error},
          dead_lettered_at = NOW(),
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'claimed'
          AND attempt_token = ${attemptToken}
        RETURNING *
      `;
      if (!rows[0]) return null;
      await transaction`
        UPDATE session_deliveries
        SET aggregate_state = 'dead_letter', dead_letter_reason = ${error},
            dead_lettered_at = NOW(), last_error = ${error}, updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND aggregate_state NOT IN ('consumed', 'dead_letter')
      `;
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId,
        outcome: "rejected",
        reason: error,
        attemptToken,
      });
      return rows[0];
    });
  }

  async listDeadLetters(limit = 100): Promise<SessionDeliveryNotificationOutboxRow[]> {
    return await this.sql<SessionDeliveryNotificationOutboxRow[]>`
      SELECT *
      FROM session_delivery_notification_outbox
      WHERE state = 'dead_letter'
        AND projection_state <> 'discarded'
      ORDER BY dead_lettered_at DESC NULLS LAST, delivery_id
      LIMIT ${limit}
    `;
  }

  async requeueDeadLetter(
    deliveryId: string,
  ): Promise<SessionDeliveryNotificationOutboxRow | null> {
    return await this.sql.begin(async (transaction) => {
      if (!await lockSessionDelivery(
        transaction as unknown as SqlClient,
        deliveryId,
      )) return null;
      const rows = await transaction<SessionDeliveryNotificationOutboxRow[]>`
        UPDATE session_delivery_notification_outbox
        SET
          state = 'pending',
          projection_state = 'staged',
          attempt_token = NULL,
          attempt_expires_at = NULL,
          attempt_count = 0,
          next_attempt_at = NOW(),
          last_error = NULL,
          dead_lettered_at = NULL,
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'dead_letter'
          AND projection_state <> 'discarded'
        RETURNING *
      `;
      if (!rows[0]) return null;
      await transaction`
        UPDATE session_deliveries
        SET aggregate_state = 'pending', dead_letter_reason = NULL,
            dead_lettered_at = NULL, last_error = NULL, updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND aggregate_state = 'dead_letter'
      `;
      return rows[0];
    });
  }

  async expireStaleNotificationAttempts(
    maxAttempts: number,
    oldestAllowedCreatedAt: Date,
  ): Promise<number> {
    return await this.sql.begin(async (transaction) => {
      const candidates = await transaction<Array<{ delivery_id: string }>>`
        SELECT delivery_id
        FROM session_delivery_notification_outbox
        WHERE (
          state = 'claimed'
          AND attempt_expires_at <= NOW()
        ) OR (
          state = 'pending'
          AND (
            attempt_count >= ${maxAttempts}
            OR created_at <= ${oldestAllowedCreatedAt}
          )
        )
        ORDER BY delivery_id
      `;
      const candidateIds = candidates.map((row) => row.delivery_id);
      await lockSessionDeliveries(
        transaction as unknown as SqlClient,
        candidateIds,
      );
      if (candidateIds.length === 0) return 0;
      const expired = await transaction<Array<{ delivery_id: string; state: string }>>`
        UPDATE session_delivery_notification_outbox
        SET
          state = CASE
            WHEN attempt_count + 1 >= ${maxAttempts}
              OR created_at <= ${oldestAllowedCreatedAt}
            THEN 'dead_letter'
            ELSE 'pending'
          END,
          attempt_token = NULL,
          attempt_expires_at = NULL,
          attempt_count = attempt_count + 1,
          next_attempt_at = NOW()
            + LEAST(
                INTERVAL '60 seconds',
                INTERVAL '100 milliseconds'
                  * POWER(2, LEAST(attempt_count, 9))
              ),
          last_error = COALESCE(last_error, 'notification attempt expired'),
          dead_lettered_at = CASE
            WHEN attempt_count + 1 >= ${maxAttempts}
              OR created_at <= ${oldestAllowedCreatedAt}
            THEN NOW()
            ELSE NULL
          END,
          updated_at = NOW()
        WHERE state = 'claimed'
          AND attempt_expires_at <= NOW()
          AND delivery_id = ANY(${transaction.array(candidateIds)})
        RETURNING delivery_id, state
      `;
      const capped = await transaction<Array<{ delivery_id: string; state: string }>>`
        UPDATE session_delivery_notification_outbox
        SET
          state = 'dead_letter',
          attempt_token = NULL,
          attempt_expires_at = NULL,
          last_error = COALESCE(last_error, 'notification retry ceiling exceeded'),
          dead_lettered_at = NOW(),
          updated_at = NOW()
        WHERE state = 'pending'
          AND delivery_id = ANY(${transaction.array(candidateIds)})
          AND (
            attempt_count >= ${maxAttempts}
            OR created_at <= ${oldestAllowedCreatedAt}
          )
        RETURNING delivery_id, state
      `;
      for (const row of [...expired, ...capped]) {
        const rejected = row.state === "dead_letter";
        const reason = rejected
          ? "notification retry ceiling exceeded"
          : "notification attempt expired";
        await transaction`
          UPDATE session_deliveries
          SET aggregate_state = ${rejected ? "dead_letter" : "pending"},
              dead_letter_reason = ${rejected ? reason : null},
              dead_lettered_at = ${rejected ? new Date() : null},
              last_error = ${reason}, updated_at = NOW()
          WHERE delivery_id = ${row.delivery_id}
            AND aggregate_state NOT IN ('consumed', 'dead_letter')
        `;
        await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
          deliveryId: row.delivery_id,
          outcome: rejected ? "rejected" : "retryable",
          reason,
        });
      }
      return expired.length + capped.length;
    });
  }
}
