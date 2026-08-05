import type {
  SessionDeliveryNotificationOutboxRow,
  SessionDeliveryRow,
  SqlClient,
} from "../control_plane_types.js";
import { asPostgresJsonValue } from "../repository_helpers.js";

export class SessionDeliveryNotificationRepository {
  constructor(private readonly sql: SqlClient) {}

  async stageWithQueuedDelivery(params: {
    deliveryId: string;
    leaseOwner: string;
    targetSessionId: string;
    disposition: "queued" | "auto_resume";
    payload: Record<string, unknown>;
  }): Promise<SessionDeliveryRow | null> {
    return await this.sql.begin(async (transaction) => {
      const advanced = await transaction<SessionDeliveryRow[]>`
        UPDATE session_deliveries
        SET state = 'queued', queued_at = NOW(), updated_at = NOW()
        WHERE delivery_id = ${params.deliveryId}
          AND state = 'dispatching'
          AND lease_owner = ${params.leaseOwner}
          AND lease_expires_at > NOW()
        RETURNING *
      `;
      const row = advanced[0];
      if (!row) return null;
      await transaction`
        INSERT INTO session_delivery_notification_outbox (
          delivery_id,
          target_session_id,
          payload,
          disposition,
          state,
          lease_owner,
          lease_expires_at,
          next_attempt_at,
          created_at,
          updated_at
        ) VALUES (
          ${params.deliveryId},
          ${params.targetSessionId},
          ${transaction.json(asPostgresJsonValue(params.payload))},
          ${params.disposition},
          'claimed',
          ${params.leaseOwner},
          ${row.lease_expires_at ?? new Date()},
          NOW(),
          NOW(),
          NOW()
        )
        ON CONFLICT (delivery_id) DO NOTHING
      `;
      return row;
    });
  }

  async claimDue(
    leaseOwner: string,
    limit = 100,
    leaseMs = 15_000,
  ): Promise<SessionDeliveryNotificationOutboxRow[]> {
    const rows = await this.sql<SessionDeliveryNotificationOutboxRow[]>`
      WITH due AS MATERIALIZED (
        SELECT outbox.delivery_id
        FROM session_delivery_notification_outbox AS outbox
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
        lease_owner = ${leaseOwner},
        lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
        updated_at = NOW()
      FROM due
      WHERE outbox.delivery_id = due.delivery_id
      RETURNING outbox.*
    `;
    return rows;
  }

  async markPublished(
    deliveryId: string,
    leaseOwner: string,
  ): Promise<SessionDeliveryNotificationOutboxRow | null> {
    const rows = await this.sql<SessionDeliveryNotificationOutboxRow[]>`
      UPDATE session_delivery_notification_outbox
      SET
        state = 'published',
        lease_owner = NULL,
        lease_expires_at = NULL,
        published_at = NOW(),
        updated_at = NOW()
      WHERE delivery_id = ${deliveryId}
        AND state = 'claimed'
        AND lease_owner = ${leaseOwner}
      RETURNING *
    `;
    return rows[0] ?? null;
  }

  async retry(
    deliveryId: string,
    leaseOwner: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<SessionDeliveryNotificationOutboxRow | null> {
    const rows = await this.sql<SessionDeliveryNotificationOutboxRow[]>`
      UPDATE session_delivery_notification_outbox
      SET
        state = 'pending',
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

  async releaseExpiredLeases(): Promise<number> {
    const rows = await this.sql<Array<{ delivery_id: string }>>`
      UPDATE session_delivery_notification_outbox
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
        last_error = COALESCE(last_error, 'notification lease expired'),
        updated_at = NOW()
      WHERE state = 'claimed'
        AND lease_expires_at <= NOW()
      RETURNING delivery_id
    `;
    return rows.length;
  }
}
