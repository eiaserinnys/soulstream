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

const DEFAULT_NOTIFICATION_LEASE_MS = 15_000;

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
    leaseOwner: string;
    targetSessionId: string;
    disposition: "queued" | "auto_resume";
    payload: Record<string, unknown>;
  }, leaseMs = DEFAULT_NOTIFICATION_LEASE_MS): Promise<SessionDeliveryRow | null> {
    const payload = validateNotificationPayload(params);
    return await this.sql.begin(async (transaction) => {
      const advanced = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET state = 'queued', aggregate_state = 'pending',
            queued_at = NOW(), updated_at = NOW()
        WHERE delivery_id = ${params.deliveryId}
          AND state = 'dispatching'
          AND lease_owner = ${params.leaseOwner}
        RETURNING *
      `;
      const row = advanced[0];
      if (!row) return null;
      const insertedOutbox = await transaction<Array<{ delivery_id: string }>>`
        INSERT INTO session_delivery_notification_outbox (
          delivery_id,
          target_session_id,
          payload,
          disposition,
          state,
          projection_state,
          lease_owner,
          lease_expires_at,
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
          ${params.leaseOwner},
          NOW() + (${leaseMs}::double precision * INTERVAL '1 millisecond'),
          NOW(),
          NOW(),
          NOW()
        )
        ON CONFLICT (delivery_id) DO NOTHING
        RETURNING delivery_id
      `;
      if (!insertedOutbox[0]) {
        throw new Error(`notification outbox already exists: ${params.deliveryId}`);
      }
      await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
        deliveryId: params.deliveryId,
        outcome: "accepted",
        reason: "durable notification admission",
        leaseOwner: params.leaseOwner,
      });
      return row;
    });
  }

  async claimDue(
    targetNodeId: string,
    leaseOwner: string,
    limit = 100,
    leaseMs = DEFAULT_NOTIFICATION_LEASE_MS,
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
                AND outbox.lease_expires_at <= NOW()
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
          lease_owner = ${leaseOwner},
          lease_expires_at = NOW() + (${leaseMs}::double precision * INTERVAL '1 millisecond'),
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
    leaseOwner: string,
    targetReceiptId: string,
  ): Promise<SessionDeliveryNotificationOutboxRow | null> {
    if (!targetReceiptId) throw new Error("notification target receipt required");
    return await this.sql.begin(async (transaction) => {
      const rows = await transaction<SessionDeliveryNotificationOutboxRow[]>`
        UPDATE session_delivery_notification_outbox
        SET
          state = 'published',
          projection_state = 'published',
          target_receipt_id = ${targetReceiptId},
          target_receipt_at = NOW(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          published_at = NOW(),
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'claimed'
          AND lease_owner = ${leaseOwner}
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
    leaseOwner: string,
    error: string,
    nextAttemptAt: Date,
    maxAttempts: number,
    oldestAllowedCreatedAt: Date,
  ): Promise<SessionDeliveryNotificationOutboxRow | null> {
    return await this.sql.begin(async (transaction) => {
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
        lease_owner = NULL,
        lease_expires_at = NULL,
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
        AND lease_owner = ${leaseOwner}
      RETURNING *
    `;
    const row = rows[0];
    if (!row) return null;
    const rejected = row.state === "dead_letter";
    await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
      deliveryId,
      outcome: rejected ? "rejected" : "retryable",
      reason: error,
      leaseOwner,
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
    leaseOwner: string,
    error: string,
  ): Promise<SessionDeliveryNotificationOutboxRow | null> {
    return await this.sql.begin(async (transaction) => {
      const rows = await transaction<SessionDeliveryNotificationOutboxRow[]>`
        UPDATE session_delivery_notification_outbox
        SET
          state = 'dead_letter',
          projection_state = 'staged',
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = ${error},
          dead_lettered_at = NOW(),
          updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND state = 'claimed'
          AND lease_owner = ${leaseOwner}
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
        leaseOwner,
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
      const rows = await transaction<SessionDeliveryNotificationOutboxRow[]>`
        UPDATE session_delivery_notification_outbox
        SET
          state = 'pending',
          projection_state = 'staged',
          lease_owner = NULL,
          lease_expires_at = NULL,
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

  async releaseExpiredLeases(
    maxAttempts: number,
    oldestAllowedCreatedAt: Date,
  ): Promise<number> {
    return await this.sql.begin(async (transaction) => {
      const expired = await transaction<Array<{ delivery_id: string; state: string }>>`
        UPDATE session_delivery_notification_outbox
        SET
          state = CASE
            WHEN attempt_count + 1 >= ${maxAttempts}
              OR created_at <= ${oldestAllowedCreatedAt}
            THEN 'dead_letter'
            ELSE 'pending'
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
          last_error = COALESCE(last_error, 'notification lease expired'),
          dead_lettered_at = CASE
            WHEN attempt_count + 1 >= ${maxAttempts}
              OR created_at <= ${oldestAllowedCreatedAt}
            THEN NOW()
            ELSE NULL
          END,
          updated_at = NOW()
        WHERE state = 'claimed'
          AND lease_expires_at <= NOW()
        RETURNING delivery_id, state
      `;
      const capped = await transaction<Array<{ delivery_id: string; state: string }>>`
        UPDATE session_delivery_notification_outbox
        SET
          state = 'dead_letter',
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'notification retry ceiling exceeded'),
          dead_lettered_at = NOW(),
          updated_at = NOW()
        WHERE state = 'pending'
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
          : "notification lease expired";
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
