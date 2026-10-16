import type postgres from "postgres";

import type { LivePostgresSql } from "./live_db_sql.js";

export type TimelineCursor = {
  readonly timestamp: string;
  readonly id: number | null;
};

export async function readTimelinePage(
  sql: LivePostgresSql,
  sessionId: string,
  eventTypes: readonly string[],
  debugKinds: readonly string[],
  cursor: TimelineCursor | null,
  limit: number,
  includeAttachmentComplete: boolean,
): Promise<readonly Record<string, unknown>[]> {
  const attachmentCompleteClause = includeAttachmentComplete
    ? sql`
        /* complete_attachment_clause */
        OR (
          event_type = 'complete'
          AND (
            (jsonb_typeof(payload->'attachment_ids') = 'array' AND payload->'attachment_ids' <> '[]'::jsonb)
            OR (jsonb_typeof(payload->'attachments') = 'array' AND payload->'attachments' <> '[]'::jsonb)
            OR (jsonb_typeof(payload->'attachment_paths') = 'array' AND payload->'attachment_paths' <> '[]'::jsonb)
          )
        )
      `
    : sql`/* complete_attachment_clause */`;
  const eventFilter = sql`
    /* timeline_event_filter_fragment */
    (
      event_type = ANY(${eventTypes}::text[])
      ${attachmentCompleteClause}
    )
    AND (event_type <> 'debug' OR payload->>'kind' = ANY(${debugKinds}::text[]))
  ` as unknown as postgres.Fragment;

  if (cursor === null) {
    return sql`
      SELECT id, parent_event_id, event_type, payload, created_at
      FROM events
      WHERE session_id = ${sessionId}
        AND ${eventFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `;
  }
  if (cursor.id === null) {
    return sql`
      SELECT id, parent_event_id, event_type, payload, created_at
      FROM events
      WHERE session_id = ${sessionId}
        AND ${eventFilter}
        AND created_at < ${cursor.timestamp}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `;
  }
  return sql`
    SELECT id, parent_event_id, event_type, payload, created_at
    FROM events
    WHERE session_id = ${sessionId}
      AND ${eventFilter}
      AND (
        created_at < ${cursor.timestamp}
        OR (created_at = ${cursor.timestamp} AND id < ${cursor.id})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;
}
