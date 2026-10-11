import type { SqlClient } from "../control_plane_types.js";

export interface PersistentSessionHistoryQuery {
  sessionId: string;
  since: Date;
  until: Date;
  cursor: number;
  limit: number;
}

export interface PersistentSessionHistoryRow {
  id: number;
  session_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
  parent_event_id: number | null;
  generation: number | null;
}

export interface PersistentSessionHistoryPage {
  rows: PersistentSessionHistoryRow[];
  nextCursor: number | null;
}

type PersistentSessionHistorySqlRow = Omit<PersistentSessionHistoryRow, "payload" | "created_at"> & {
  payload: unknown;
  created_at: Date | string;
};

export async function readPersistentSessionHistory(
  sql: SqlClient,
  query: PersistentSessionHistoryQuery,
): Promise<PersistentSessionHistoryPage> {
  let cursorCreatedAt: Date | null = null;
  if (query.cursor > 0) {
    const cursorRows = await sql<Array<{ created_at: Date | string }>>`
      SELECT created_at
      FROM events
      WHERE session_id = ${query.sessionId} AND id = ${query.cursor}
    `;
    if (!cursorRows[0]) throw new Error("History cursor does not belong to this session or no longer exists");
    cursorCreatedAt = cursorRows[0].created_at instanceof Date
      ? cursorRows[0].created_at
      : new Date(cursorRows[0].created_at);
  }

  const fetched = await sql<PersistentSessionHistorySqlRow[]>`
    WITH ranked_inputs AS MATERIALIZED (
      SELECT
        e.id,
        e.session_id,
        e.event_type,
        e.payload,
        e.created_at,
        e.parent_event_id,
        row_number() OVER (
          PARTITION BY CASE
            WHEN NULLIF(e.payload->>'input_id', '') IS NULL THEN 'event:' || e.id::text
            ELSE 'input:' || (e.payload->>'input_id')
          END
          ORDER BY e.created_at ASC, e.id ASC
        ) AS input_rank
      FROM events e
      WHERE e.session_id = ${query.sessionId}
        AND e.event_type IN ('user_message', 'intervention_sent')
    ), history_events AS (
      SELECT id, session_id, event_type, payload, created_at, parent_event_id
      FROM ranked_inputs
      WHERE input_rank = 1
      UNION ALL
      SELECT id, session_id, event_type, payload, created_at, parent_event_id
      FROM events
      WHERE session_id = ${query.sessionId}
        AND event_type IN ('assistant_message', 'session_notification', 'generation_started')
    )
    SELECT
      history.id,
      history.session_id,
      history.event_type,
      history.payload,
      history.created_at,
      history.parent_event_id,
      generation.generation
    FROM history_events history
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN boundary.payload->>'generation' ~ '^[0-9]+$'
          THEN (boundary.payload->>'generation')::integer
        ELSE NULL
      END AS generation
      FROM events boundary
      WHERE boundary.session_id = history.session_id
        AND boundary.event_type = 'generation_started'
        AND boundary.id <= history.id
      ORDER BY boundary.id DESC
      LIMIT 1
    ) generation ON true
    WHERE history.created_at >= ${query.since}
      AND history.created_at < ${query.until}
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (history.created_at, history.id) > (${cursorCreatedAt}::timestamptz, ${query.cursor}::integer)
      )
    ORDER BY history.created_at ASC, history.id ASC
    LIMIT ${query.limit + 1}
  `;

  const hasMore = fetched.length > query.limit;
  const rows = fetched.slice(0, query.limit).map((row) => ({
    ...row,
    payload: isRecord(row.payload) ? row.payload : {},
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  }));
  return {
    rows,
    nextCursor: hasMore ? rows[rows.length - 1]?.id ?? null : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
