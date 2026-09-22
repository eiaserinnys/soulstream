import type { EventFeedProjectionApplication } from "./event_feed_projection_applier.js";
import type { EventIngressQuerySql } from "./event_ingress_repository.js";
import type {
  EventSessionEffect,
  EventSessionEffectApplication,
} from "./event_ingress_types.js";

export type FeedSemanticIngressInput = {
  readonly effect: EventSessionEffect | null;
  readonly sessionEffectApplication?: EventSessionEffectApplication;
  readonly feedProjectionApplication?: EventFeedProjectionApplication | null;
};

/**
 * Feed unread state shares the durable raw event-id coordinate, but advances
 * only when the feed projection changed. Raw detail events deliberately do
 * not pass this gate. Old clients therefore retain raw-last-event fallback and
 * can lag no-op raw unread changes until their next snapshot; do not emit a
 * synthetic compatibility frame merely to advance that old-client value.
 */
export function hasFeedSemanticIngressChange(
  input: FeedSemanticIngressInput,
): boolean {
  if (input.feedProjectionApplication !== null
    && input.feedProjectionApplication !== undefined) {
    return true;
  }
  const application = input.sessionEffectApplication;
  if (application?.applied !== true) return false;
  if (input.effect?.kind === "last_message") {
    return application.canonicalLastMessage !== null
      && application.canonicalLastMessage !== undefined;
  }
  return application.canonicalSession !== null
    && application.canonicalSession !== undefined;
}

/**
 * There is intentionally no historical backfill from raw `last_event_id`.
 * NULL means that a row predates this projection and clients must use their
 * raw-coordinate fallback until the next actual feed-semantic event.
 */
export async function advanceSessionFeedLastEventId(
  sql: EventIngressQuerySql,
  input: {
    readonly sessionId: string;
    readonly eventId: number;
    readonly createdAt: string;
  },
): Promise<number> {
  if (!Number.isSafeInteger(input.eventId) || input.eventId <= 0) {
    throw new Error("feed semantic watermark requires a positive event id");
  }
  const rows = await sql<Array<{ feed_last_event_id: number }>>`
    INSERT INTO session_feed_state (
      session_id, feed_last_event_id, updated_at
    ) VALUES (
      ${input.sessionId}, ${input.eventId}, ${new Date(input.createdAt)}
    )
    ON CONFLICT (session_id) DO UPDATE
    SET feed_last_event_id = CASE
          WHEN session_feed_state.feed_last_event_id IS NULL
            THEN EXCLUDED.feed_last_event_id
          ELSE GREATEST(
            session_feed_state.feed_last_event_id,
            EXCLUDED.feed_last_event_id
          )
        END,
        updated_at = GREATEST(
          session_feed_state.updated_at,
          EXCLUDED.updated_at
        )
    RETURNING feed_last_event_id
  `;
  const value = rows[0]?.feed_last_event_id;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("feed semantic watermark did not return a positive event id");
  }
  return value;
}
