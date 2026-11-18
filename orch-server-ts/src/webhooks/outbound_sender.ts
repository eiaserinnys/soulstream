import type postgres from "postgres";
import type { AuthUserAuthorizer } from "../auth/auth_routes.js";
import { SERVICE_CALLER, type ServiceCaller } from "../auth/service_caller.js";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import { WebhookError, type WebhookPost } from "../external_events/webhook_transport.js";
import { standardWebhookHeaders } from "./standard_webhook_signature.js";
import type { WebhookDeliveryRow, WebhookSubscriptionRow } from "./outbound_types.js";

type Transaction = postgres.TransactionSql<any>;

export type OutboundSessionAccess = (input: {
  request: ServiceCaller;
  sessionId: string;
  accessEmail: string;
}) => Promise<void>;

export type OutboundSenderDependencies = {
  sql: SqlClient;
  post: WebhookPost;
  authorizeUser: AuthUserAuthorizer;
  requireSessionAccess: OutboundSessionAccess;
  now: () => number;
};

export type DeliveryAttemptOutcome = "delivered" | "retrying" | "dead" | "skipped";

const RETRY_BASE_SECONDS = 10;
const RETRY_MAX_SECONDS = 3600;
const MAX_ATTEMPTS = 16;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 20;

/**
 * Picks one due pending delivery whose subscription is active and drives it
 * through the single send entry. Returns false when nothing is due.
 */
export async function sendNextDueDelivery(
  deps: OutboundSenderDependencies,
): Promise<boolean> {
  const now = new Date(deps.now());
  const candidates = await deps.sql<Array<{ id: string }>>`
    SELECT delivery.id
    FROM webhook_deliveries delivery
    JOIN webhook_subscriptions subscription ON subscription.id = delivery.subscription_id
    WHERE delivery.state = 'pending'
      AND delivery.next_attempt_at <= ${now}
      AND subscription.active
    ORDER BY delivery.next_attempt_at, delivery.created_at, delivery.id
    LIMIT 1
  `;
  const candidate = candidates[0];
  if (candidate === undefined) return false;
  return (await sendDelivery(deps, candidate.id)) !== "skipped";
}

/**
 * The one send entry shared by automatic retries and manual redelivery. It
 * locks the subscription and the delivery row for the whole POST and records
 * the outcome in the same transaction.
 */
export async function sendDelivery(
  deps: OutboundSenderDependencies,
  deliveryId: string,
): Promise<DeliveryAttemptOutcome> {
  const nowMs = deps.now();
  const now = new Date(nowMs);
  return await deps.sql.begin(async (transaction) => {
    const owners = await transaction<Array<{ subscription_id: string }>>`
      SELECT subscription_id FROM webhook_deliveries WHERE id = ${deliveryId}
    `;
    const subscriptionId = owners[0]?.subscription_id;
    if (subscriptionId === undefined) return "skipped";

    const subscriptions = await transaction<WebhookSubscriptionRow[]>`
      SELECT * FROM webhook_subscriptions WHERE id = ${subscriptionId} FOR UPDATE
    `;
    const subscription = subscriptions[0];
    if (subscription === undefined || !subscription.active) return "skipped";

    const deliveries = await transaction<WebhookDeliveryRow[]>`
      SELECT * FROM webhook_deliveries
      WHERE id = ${deliveryId} AND state = 'pending' AND next_attempt_at <= ${now}
      FOR UPDATE SKIP LOCKED
    `;
    const delivery = deliveries[0];
    if (delivery === undefined) return "skipped";

    const targets = await transaction<Array<{ session_id: string }>>`
      SELECT session_id FROM sessions WHERE session_id = ${subscription.target_session_id}
    `;
    if (targets[0] === undefined) {
      return await markDead(transaction, subscription, delivery, now, null, "target_missing");
    }

    let allowed = false;
    try {
      const denied = await deps.authorizeUser({ email: subscription.owner_email });
      if (!denied) {
        await deps.requireSessionAccess({
          request: SERVICE_CALLER,
          sessionId: subscription.target_session_id,
          accessEmail: subscription.owner_email,
        });
        allowed = true;
      }
    } catch {
      allowed = false;
    }
    if (!allowed) {
      return await markDead(transaction, subscription, delivery, now, null, "access_revoked");
    }

    const body = JSON.stringify(delivery.payload);
    const headers = standardWebhookHeaders({
      secret: subscription.signing_secret,
      webhookId: delivery.payload.id,
      body,
      now: nowMs,
    });

    let response: Awaited<ReturnType<WebhookPost>> | undefined;
    let failure: unknown;
    try {
      response = await deps.post(subscription.url, body, headers);
    } catch (error) {
      failure = error;
    }

    if (response !== undefined) {
      const status = response.status;
      if (status >= 200 && status < 300) {
        await transaction`
          UPDATE webhook_deliveries
          SET state = 'delivered', delivered_at = ${now}, last_status = ${status}, last_error = NULL
          WHERE id = ${delivery.id}
        `;
        await transaction`
          UPDATE webhook_subscriptions SET consecutive_failures = 0, updated_at = ${now}
          WHERE id = ${subscription.id}
        `;
        return "delivered";
      }
      if (status === 410) {
        return await markDead(
          transaction, subscription, delivery, now, status, "http_410", "gone",
        );
      }
      if (status === 429 || status >= 500) {
        const retryAfter = status === 429
          ? retryAfterSeconds(response.retryAfter, nowMs)
          : null;
        const delay = retryAfter ?? backoffSeconds(delivery.attempt_count + 1);
        return await markTransient(
          transaction, subscription, delivery, now, status, `http_${status}`, delay,
        );
      }
      return await markDead(transaction, subscription, delivery, now, status, `http_${status}`);
    }

    if (failure instanceof WebhookError && failure.transient) {
      return await markTransient(
        transaction,
        subscription,
        delivery,
        now,
        null,
        failure.reason,
        backoffSeconds(delivery.attempt_count + 1),
      );
    }
    const reason = failure instanceof WebhookError ? failure.reason : "network_error";
    return await markDead(transaction, subscription, delivery, now, null, reason);
  });
}

function backoffSeconds(attempts: number): number {
  return Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** (attempts - 1));
}

function retryAfterSeconds(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(RETRY_MAX_SECONDS, Number(trimmed));
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(RETRY_MAX_SECONDS, Math.max(0, Math.round((at - nowMs) / 1000)));
}

async function markTransient(
  transaction: Transaction,
  subscription: WebhookSubscriptionRow,
  delivery: WebhookDeliveryRow,
  now: Date,
  status: number | null,
  reason: string,
  delaySeconds: number,
): Promise<"retrying" | "dead"> {
  const attempts = delivery.attempt_count + 1;
  const expired = now.getTime() - delivery.window_started_at.getTime() >= MAX_WINDOW_MS;
  if (attempts >= MAX_ATTEMPTS || expired) {
    return await markDead(
      transaction, subscription, delivery, now, status, reason, undefined, attempts,
    );
  }
  const nextAttemptAt = new Date(
    now.getTime() + Math.max(0, Math.min(RETRY_MAX_SECONDS, delaySeconds)) * 1000,
  );
  await transaction`
    UPDATE webhook_deliveries
    SET attempt_count = ${attempts}, next_attempt_at = ${nextAttemptAt},
        last_status = ${status}, last_error = ${reason}
    WHERE id = ${delivery.id}
  `;
  return "retrying";
}

async function markDead(
  transaction: Transaction,
  subscription: WebhookSubscriptionRow,
  delivery: WebhookDeliveryRow,
  now: Date,
  status: number | null,
  reason: string,
  disableReason?: string,
  attemptCount?: number,
): Promise<"dead"> {
  await transaction`
    UPDATE webhook_deliveries
    SET state = 'dead', attempt_count = ${attemptCount ?? delivery.attempt_count},
        last_status = ${status}, last_error = ${reason}
    WHERE id = ${delivery.id}
  `;
  const failures = subscription.consecutive_failures + 1;
  const disabledReason = disableReason ??
    (failures >= MAX_CONSECUTIVE_FAILURES ? "consecutive_failures" : null);
  await transaction`
    UPDATE webhook_subscriptions
    SET consecutive_failures = ${failures},
        active = ${disabledReason === null ? subscription.active : false},
        disabled_reason = ${disabledReason ?? subscription.disabled_reason},
        updated_at = ${now}
    WHERE id = ${subscription.id}
  `;
  return "dead";
}
