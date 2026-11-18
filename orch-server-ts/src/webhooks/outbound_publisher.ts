import { randomUUID } from "node:crypto";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import { asPostgresJsonValue } from "../control_plane/repository_helpers.js";
import type {
  OutboundEventType,
  OutboundNotification,
  SourceEventRow,
  WebhookSubscriptionRow,
} from "./outbound_types.js";

/** Upper bound of deliveries one publisher run inserts for a subscription. */
const MAX_DELIVERIES_PER_PUBLISH = 200;

export type PublishResult = { inserted: number; cursor: number };

/**
 * Maps a stored session event to the notification it produces. `error` events
 * and every other session event are not notification sources.
 */
export function notificationForEvent(
  sessionId: string,
  event: SourceEventRow,
): { type: OutboundEventType; data: Record<string, unknown> } | null {
  const payload = event.payload ?? {};
  switch (event.event_type) {
    case "complete":
      return {
        type: "session.reply",
        data: {
          session_id: sessionId,
          result: typeof payload.result === "string" ? payload.result : null,
        },
      };
    case "input_request":
      return {
        type: "session.question",
        data: {
          session_id: sessionId,
          request_id: typeof payload.request_id === "string" ? payload.request_id : null,
          questions: questionsOf(payload.questions),
          expires_at: expiresAt(payload),
        },
      };
    case "session_ended": {
      const reason =
        typeof payload.termination_reason === "string" ? payload.termination_reason : "unknown";
      const type = reason === "completed_ok" || reason === "killed"
        ? "session.ended"
        : "session.failed";
      return { type, data: { session_id: sessionId, termination_reason: reason } };
    }
    default:
      return null;
  }
}

/**
 * Publishes one active subscription in a single transaction: the subscription
 * row is locked, the target session's last event id is the upper bound, and
 * notifications become pending deliveries under the cursor.
 */
export async function publishSubscription(
  sql: SqlClient,
  subscriptionId: string,
  now: Date,
): Promise<PublishResult | null> {
  return await sql.begin(async (transaction) => {
    const subscriptions = await transaction<WebhookSubscriptionRow[]>`
      SELECT * FROM webhook_subscriptions WHERE id = ${subscriptionId} FOR UPDATE
    `;
    const subscription = subscriptions[0];
    if (subscription === undefined || !subscription.active) return null;

    const sessions = await transaction<Array<{ last_event_id: number | null }>>`
      SELECT last_event_id FROM sessions WHERE session_id = ${subscription.target_session_id}
    `;
    const bound = sessions[0]?.last_event_id ?? 0;
    if (bound <= subscription.cursor_event_id) {
      return { inserted: 0, cursor: subscription.cursor_event_id };
    }

    const events = await transaction<SourceEventRow[]>`
      SELECT id, event_type, payload, created_at
      FROM events
      WHERE session_id = ${subscription.target_session_id}
        AND id > ${subscription.cursor_event_id}
        AND id <= ${bound}
        AND event_type IN ('complete', 'input_request', 'session_ended')
      ORDER BY id
      LIMIT ${MAX_DELIVERIES_PER_PUBLISH}
    `;

    let inserted = 0;
    for (const event of events) {
      const notification = notificationForEvent(subscription.target_session_id, event);
      if (notification === null || !subscription.event_types.includes(notification.type)) continue;
      const payload: OutboundNotification = {
        id: `${subscription.id}:${subscription.target_session_id}:${event.id}`,
        type: notification.type,
        timestamp: (event.created_at ?? now).toISOString(),
        data: notification.data,
      };
      const result = await transaction<Array<{ id: string }>>`
        INSERT INTO webhook_deliveries (
          id, subscription_id, session_id, event_id, event_type, payload,
          state, attempt_count, next_attempt_at, window_started_at, created_at
        ) VALUES (
          ${randomUUID()}, ${subscription.id}, ${subscription.target_session_id}, ${event.id},
          ${notification.type}, ${transaction.json(asPostgresJsonValue(payload))},
          'pending', 0, ${now}, ${now}, ${now}
        )
        ON CONFLICT (subscription_id, session_id, event_id) DO NOTHING
        RETURNING id
      `;
      inserted += result.length;
    }

    const cursor = events.length === MAX_DELIVERIES_PER_PUBLISH
      ? Number(events[events.length - 1]!.id)
      : bound;
    await transaction`
      UPDATE webhook_subscriptions SET cursor_event_id = ${cursor}, updated_at = ${now}
      WHERE id = ${subscription.id}
    `;
    return { inserted, cursor };
  });
}

/**
 * Publishes every active subscription that has event ids past its cursor. The
 * periodic sweep uses this to cover events the live hub never sees.
 */
export async function publishDueSubscriptions(
  sql: SqlClient,
  now: Date,
): Promise<Array<PublishResult & { subscriptionId: string }>> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT subscription.id
    FROM webhook_subscriptions subscription
    JOIN sessions target ON target.session_id = subscription.target_session_id
    WHERE subscription.active
      AND target.last_event_id IS NOT NULL
      AND subscription.cursor_event_id < target.last_event_id
    ORDER BY subscription.updated_at, subscription.id
  `;
  const results: Array<PublishResult & { subscriptionId: string }> = [];
  for (const row of rows) {
    const result = await publishSubscription(sql, row.id, now);
    if (result !== null) results.push({ subscriptionId: row.id, ...result });
  }
  return results;
}

/** Active subscriptions that target the given session. */
export async function activeSubscriptionIdsForSession(
  sql: SqlClient,
  sessionId: string,
): Promise<string[]> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM webhook_subscriptions
    WHERE target_session_id = ${sessionId} AND active
  `;
  return rows.map((row) => row.id);
}

function questionsOf(value: unknown): Array<{
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multi_select: boolean;
}> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const question = recordOf(item);
    const options = Array.isArray(question.options) ? question.options.map((option) => {
      const entry = recordOf(option);
      return {
        label: typeof entry.label === "string" ? entry.label : "",
        description: typeof entry.description === "string" ? entry.description : "",
      };
    }) : [];
    return {
      question: typeof question.question === "string" ? question.question : "",
      header: typeof question.header === "string" ? question.header : "",
      options,
      multi_select: question.multiSelect === true,
    };
  });
}

function expiresAt(payload: Record<string, unknown>): string | null {
  const startedAt = payload.started_at;
  const timeoutSec = payload.timeout_sec;
  if (
    typeof startedAt !== "number" || !Number.isFinite(startedAt) ||
    typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec)
  ) {
    return null;
  }
  return new Date((startedAt + timeoutSec) * 1000).toISOString();
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
