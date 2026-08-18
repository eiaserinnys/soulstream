import type {
  SessionDeliveryNotificationOutboxRow,
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";
import { asPostgresJsonValue } from "../repository_helpers.js";
import { appendSessionDeliveryAttempt } from
  "./session_delivery_attempt_repository.js";

const DEFAULT_NOTIFICATION_LEASE_MS = 15_000;

export class SessionDeliveryNotificationRepository {
  constructor(private readonly sql: SqlClient) {}

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
          NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
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
      const orphaned = await transaction<Array<{ delivery_id: string }>>`
        UPDATE session_delivery_notification_outbox AS outbox
        SET
          state = 'dead_letter',
          projection_state = 'staged',
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = 'notification target session has no owner node',
          dead_lettered_at = NOW(),
          updated_at = NOW()
        WHERE outbox.state IN ('pending', 'claimed')
          AND NOT EXISTS (
            SELECT 1 FROM sessions AS target
            WHERE target.session_id = outbox.target_session_id
              AND target.node_id IS NOT NULL
          )
        RETURNING outbox.delivery_id
      `;
      for (const row of orphaned) {
        const reason = "notification target session has no owner node";
        await transaction`
          UPDATE session_deliveries
          SET aggregate_state = 'dead_letter', dead_letter_reason = ${reason},
              dead_lettered_at = NOW(), last_error = ${reason}, updated_at = NOW()
          WHERE delivery_id = ${row.delivery_id}
            AND aggregate_state NOT IN ('consumed', 'dead_letter')
        `;
        await appendSessionDeliveryAttempt(transaction as unknown as SqlClient, {
          deliveryId: row.delivery_id,
          outcome: "rejected",
          reason,
        });
      }
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
          lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
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
        SET state = 'delivered', aggregate_state = 'delivered',
            target_receipt_id = ${targetReceiptId}, target_receipt_at = NOW(),
            delivered_at = NOW(), updated_at = NOW()
        WHERE delivery_id = ${deliveryId}
          AND aggregate_state = 'pending'
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

const NOTIFICATION_PAYLOAD_KEYS = new Set([
  "text",
  "user",
  "caller_info",
  "source",
  "delivery_id",
  "delivery_intent",
  "completion_id",
  "relation_key",
  "followup_key",
  "followup_attempt",
  "disposition",
]);

function validateNotificationPayload(params: {
  deliveryId: string;
  disposition: "queued" | "auto_resume";
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const { payload } = params;
  for (const key of Object.keys(payload)) {
    if (!NOTIFICATION_PAYLOAD_KEYS.has(key)) {
      throw new Error(`Notification outbox payload has unexpected field ${key}`);
    }
  }
  for (const key of [
    "text",
    "user",
    "source",
    "delivery_id",
    "delivery_intent",
    "completion_id",
    "relation_key",
  ] as const) {
    if (typeof payload[key] !== "string" || payload[key].length === 0) {
      throw new Error(`Notification outbox payload is missing ${key}`);
    }
  }
  if (
    payload.delivery_intent !== "completion_notification" &&
    payload.delivery_intent !== "runtime_followup"
  ) {
    throw new Error(
      `Notification outbox payload has unsupported delivery_intent ${String(payload.delivery_intent)}`,
    );
  }
  if (
    payload.followup_key !== undefined &&
    payload.followup_key !== null &&
    (typeof payload.followup_key !== "string" || payload.followup_key.length === 0)
  ) {
    throw new Error("Notification outbox payload followup_key must be a string or null");
  }
  if (
    payload.followup_attempt !== undefined &&
    payload.followup_attempt !== null &&
    (typeof payload.followup_attempt !== "number" ||
      !Number.isInteger(payload.followup_attempt) ||
      payload.followup_attempt < 1)
  ) {
    throw new Error(
      "Notification outbox payload followup_attempt must be a positive integer or null",
    );
  }
  if (
    (payload.followup_key !== undefined && payload.followup_key !== null) !==
      (payload.followup_attempt !== undefined && payload.followup_attempt !== null)
  ) {
    throw new Error(
      "Notification outbox payload followup_key and followup_attempt must be provided together",
    );
  }
  if (payload.delivery_id !== params.deliveryId) {
    throw new Error(
      "Notification outbox payload delivery_id does not match the staged delivery",
    );
  }
  if (payload.disposition !== params.disposition) {
    throw new Error(
      "Notification outbox payload disposition does not match the staged delivery",
    );
  }
  if (
    payload.caller_info !== null &&
    (typeof payload.caller_info !== "object" || Array.isArray(payload.caller_info))
  ) {
    throw new Error("Notification outbox payload caller_info must be an object or null");
  }
  return payload;
}
