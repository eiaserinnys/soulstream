import { randomBytes, randomUUID } from "node:crypto";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import type {
  CreateSubscriptionInput,
  DeliveryState,
  WebhookDeliveryRow,
  WebhookSubscriptionRow,
  WebhookSubscriptionSummary,
} from "./outbound_types.js";

const DEFAULT_DELIVERY_LIMIT = 50;
const MAX_DELIVERY_LIMIT = 200;

export function generateSigningSecret(): string {
  return "whsec_" + randomBytes(32).toString("base64");
}

export type OutboundWebhookRepositoryOptions = {
  resolveSql: () => Promise<SqlClient>;
  now: () => number;
};

export type RedeliveryReset =
  | { ok: true }
  | { ok: false; reason: "not_found" | "subscription_inactive" };

/**
 * Management storage for subscriptions and deliveries. Every method is scoped
 * to the subscription owner and never returns the signing secret.
 */
export class OutboundWebhookRepository {
  constructor(private readonly options: OutboundWebhookRepositoryOptions) {}

  private async sql(): Promise<SqlClient> {
    return await this.options.resolveSql();
  }

  private now(): Date {
    return new Date(this.options.now());
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<WebhookSubscriptionSummary> {
    const sql = await this.sql();
    const at = this.now();
    const rows = await sql<WebhookSubscriptionRow[]>`
      INSERT INTO webhook_subscriptions (
        id, owner_email, label, target_session_id, event_types, url, signing_secret,
        cursor_event_id, created_at, updated_at
      ) VALUES (
        ${randomUUID()}, ${input.ownerEmail}, ${input.label}, ${input.targetSessionId},
        ${sql.array([...input.eventTypes])}::text[], ${input.url}, ${input.signingSecret},
        COALESCE(
          (SELECT last_event_id FROM sessions WHERE session_id = ${input.targetSessionId}), 0
        ),
        ${at}, ${at}
      )
      RETURNING *
    `;
    return summaryOf(rows[0]!);
  }

  async listSubscriptions(ownerEmail: string): Promise<WebhookSubscriptionSummary[]> {
    const sql = await this.sql();
    const rows = await sql<WebhookSubscriptionRow[]>`
      SELECT * FROM webhook_subscriptions
      WHERE owner_email = ${ownerEmail}
      ORDER BY created_at DESC, id
    `;
    return rows.map((row) => summaryOf(row));
  }

  async getSubscription(
    ownerEmail: string,
    subscriptionId: string,
  ): Promise<WebhookSubscriptionSummary | null> {
    const sql = await this.sql();
    const rows = await sql<Array<WebhookSubscriptionRow & { recent_failures: number }>>`
      SELECT subscription.*, (
        SELECT COUNT(*)::int FROM webhook_deliveries delivery
        WHERE delivery.subscription_id = subscription.id AND delivery.state = 'dead'
      ) AS recent_failures
      FROM webhook_subscriptions subscription
      WHERE subscription.id = ${subscriptionId} AND subscription.owner_email = ${ownerEmail}
    `;
    const row = rows[0];
    return row === undefined ? null : summaryOf(row, row.recent_failures);
  }

  async listDeliveries(
    ownerEmail: string,
    subscriptionId: string,
    options: { state?: DeliveryState; limit?: number } = {},
  ): Promise<WebhookDeliveryRow[]> {
    const sql = await this.sql();
    const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_DELIVERY_LIMIT, MAX_DELIVERY_LIMIT));
    return await sql<WebhookDeliveryRow[]>`
      SELECT delivery.*
      FROM webhook_deliveries delivery
      JOIN webhook_subscriptions subscription ON subscription.id = delivery.subscription_id
      WHERE subscription.owner_email = ${ownerEmail}
        AND subscription.id = ${subscriptionId}
        ${options.state === undefined ? sql`` : sql`AND delivery.state = ${options.state}`}
      ORDER BY delivery.created_at DESC, delivery.id DESC
      LIMIT ${limit}
    `;
  }

  async deleteSubscription(ownerEmail: string, subscriptionId: string): Promise<boolean> {
    const sql = await this.sql();
    const rows = await sql<Array<{ id: string }>>`
      DELETE FROM webhook_subscriptions
      WHERE id = ${subscriptionId} AND owner_email = ${ownerEmail}
      RETURNING id
    `;
    return rows.length > 0;
  }

  async setActive(
    ownerEmail: string,
    subscriptionId: string,
    active: boolean,
  ): Promise<WebhookSubscriptionSummary | null> {
    const sql = await this.sql();
    return await sql.begin(async (transaction) => {
      const subscriptions = await transaction<WebhookSubscriptionRow[]>`
        SELECT * FROM webhook_subscriptions
        WHERE id = ${subscriptionId} AND owner_email = ${ownerEmail}
        FOR UPDATE
      `;
      const subscription = subscriptions[0];
      if (subscription === undefined) return null;
      const at = this.now();

      if (!active) {
        const rows = await transaction<WebhookSubscriptionRow[]>`
          UPDATE webhook_subscriptions
          SET active = false, disabled_reason = 'user_disabled', updated_at = ${at}
          WHERE id = ${subscription.id}
          RETURNING *
        `;
        return summaryOf(rows[0]!);
      }

      await transaction`
        UPDATE webhook_deliveries
        SET state = 'dead', last_error = 'disabled_while_pending'
        WHERE subscription_id = ${subscription.id} AND state = 'pending'
      `;
      const rows = await transaction<WebhookSubscriptionRow[]>`
        UPDATE webhook_subscriptions
        SET active = true,
            disabled_reason = NULL,
            consecutive_failures = 0,
            cursor_event_id = COALESCE(
              (SELECT last_event_id FROM sessions WHERE session_id = ${subscription.target_session_id}),
              0
            ),
            updated_at = ${at}
        WHERE id = ${subscription.id}
        RETURNING *
      `;
      return summaryOf(rows[0]!);
    });
  }

  async resetForRedelivery(
    ownerEmail: string,
    deliveryId: string,
  ): Promise<RedeliveryReset> {
    const sql = await this.sql();
    return await sql.begin(async (transaction) => {
      const rows = await transaction<Array<{ active: boolean }>>`
        SELECT subscription.active
        FROM webhook_deliveries delivery
        JOIN webhook_subscriptions subscription ON subscription.id = delivery.subscription_id
        WHERE delivery.id = ${deliveryId} AND subscription.owner_email = ${ownerEmail}
        FOR UPDATE OF subscription
      `;
      const row = rows[0];
      if (row === undefined) return { ok: false as const, reason: "not_found" as const };
      if (!row.active) {
        return { ok: false as const, reason: "subscription_inactive" as const };
      }
      const at = this.now();
      await transaction`
        UPDATE webhook_deliveries
        SET state = 'pending', attempt_count = 0,
            next_attempt_at = ${at}, window_started_at = ${at}
        WHERE id = ${deliveryId}
      `;
      return { ok: true as const };
    });
  }
}

function summaryOf(
  row: WebhookSubscriptionRow,
  recentFailures?: number,
): WebhookSubscriptionSummary {
  const { signing_secret: _signingSecret, ...rest } = row;
  return recentFailures === undefined ? rest : { ...rest, recent_failures: recentFailures };
}
