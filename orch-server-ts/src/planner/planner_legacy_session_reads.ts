import type {
  PlannerLegacySessionDto,
  PlannerPageSlice,
} from "./planner_contract.js";
import { decodeCursor, encodeCursor } from "./planner_repository_reads.js";
import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import { serializeSessionRow } from "../runtime/live_session_serialization.js";

interface LegacySessionRow extends Record<string, unknown> {
  session_id: string;
  updated_at_cursor: string;
}

export async function listProjectLegacySessions(
  sql: LivePostgresSql,
  pageId: string,
  input: { cursor?: string; limit: number },
): Promise<PlannerPageSlice<PlannerLegacySessionDto>> {
  const cursor = input.cursor ? decodeCursor(input.cursor, "legacy-session") : null;
  const updatedAt = cursor?.first ?? null;
  const cursorId = cursor?.second ?? "";
  const rows = await sql`
    WITH project_folder AS (
      SELECT folder.id
      FROM folders folder
      WHERE folder.project_page_id = ${pageId}
        AND folder.archived = FALSE
      LIMIT 1
    )
    SELECT session.*,
           to_char(
             session.updated_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) AS updated_at_cursor
    FROM project_folder folder
    JOIN board_items item
      ON item.container_kind = 'folder'
     AND item.container_id = folder.id
     AND item.membership_kind = 'primary'
     AND item.item_type = 'session'
    JOIN sessions session ON session.session_id = item.item_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM board_items task_item
      WHERE task_item.item_type = 'session'
        AND task_item.item_id = session.session_id
        AND task_item.membership_kind = 'primary'
        AND task_item.container_kind = 'task'
    )
      AND (
        ${updatedAt}::text IS NULL
        OR (session.updated_at, session.session_id) < (
          ${updatedAt}::timestamptz,
          ${cursorId}
        )
      )
    ORDER BY session.updated_at DESC, session.session_id DESC
    LIMIT ${input.limit + 1}
  ` as readonly LegacySessionRow[];
  const visible = rows.slice(0, input.limit);
  const last = visible.at(-1);
  return {
    items: visible.map(serializeLegacySession),
    next_cursor: rows.length > input.limit && last
      ? encodeCursor("legacy-session", last.updated_at_cursor, last.session_id)
      : null,
  };
}

function serializeLegacySession(row: LegacySessionRow): PlannerLegacySessionDto {
  return {
    ...serializeSessionRow(row),
    agentSessionId: row.session_id,
    status: String(row.status ?? "unknown"),
    eventCount: 0,
  };
}
