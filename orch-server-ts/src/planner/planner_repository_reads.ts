import { Buffer } from "node:buffer";

import type {
  PlannerDailyHistoryDto,
  PlannerPageDto,
  PlannerPageSlice,
  PlannerTaskRunPageDto,
} from "./planner_contract.js";
import type { LivePostgresSql } from "../runtime/live_db_sql.js";

export class PlannerCursorError extends Error {
  readonly code = "PLANNER_CURSOR_INVALID";
}

interface StarredTaskRow extends Record<string, unknown> {
  id: string;
  updated_at_cursor: string;
  payload: PlannerPageDto;
}

interface TaskRunRow extends Record<string, unknown> {
  task_id: string;
  runs: Array<{ agent_session_id: string; updated_at_cursor: string }>;
  total: number;
}

export interface PlannerMountCursor {
  position: string;
  id: string;
}

export async function listStarredTasks(
  sql: LivePostgresSql,
  input: { cursor?: string; limit: number },
): Promise<PlannerPageSlice<PlannerPageDto>> {
  const cursor = input.cursor ? decodeCursor(input.cursor, "starred-task") : null;
  const updatedAt = cursor?.first ?? null;
  const cursorId = cursor?.second ?? "";
  const rows = await sql`
    SELECT p.id,
           to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             AS updated_at_cursor,
           jsonb_build_object(
             'id', p.id,
             'title', p.title,
             'daily_date', p.daily_date::text,
             'version', p.version,
             'archived', p.archived,
             'metadata', p.metadata,
             'created_at', p.created_at,
             'updated_at', p.updated_at
           ) AS payload
    FROM pages p
    WHERE p.archived = FALSE
      AND p.daily_date IS NULL
      AND COALESCE((p.metadata->>'starred')::boolean, FALSE)
      AND EXISTS (
        SELECT 1
        FROM blocks b
        WHERE b.page_id = p.id
          AND b.block_type IN ('task_ref', 'runbook_ref')
          AND COALESCE((b.properties->>'primary')::boolean, FALSE)
          AND NULLIF(BTRIM(CASE b.block_type
            WHEN 'task_ref' THEN b.properties->>'taskId'
            WHEN 'runbook_ref' THEN b.properties->>'runbookId'
          END), '') IS NOT NULL
      )
      AND (
        ${updatedAt}::text IS NULL
        OR (p.updated_at, p.id) < (${updatedAt}::timestamptz, ${cursorId})
      )
    ORDER BY p.updated_at DESC, p.id DESC
    LIMIT ${input.limit + 1}
  ` as readonly StarredTaskRow[];
  const visible = rows.slice(0, input.limit);
  const last = visible.at(-1);
  return {
    items: visible.map((row) => row.payload),
    next_cursor: rows.length > input.limit && last
      ? encodeCursor("starred-task", last.updated_at_cursor, last.id)
      : null,
  };
}

export async function listDailyHistory(
  sql: LivePostgresSql,
  input: { before: string; limit: number },
): Promise<PlannerDailyHistoryDto> {
  const rows = await sql`
    SELECT daily_date::text AS daily_date
    FROM pages
    WHERE archived = FALSE
      AND daily_date IS NOT NULL
      AND daily_date < ${input.before}::date
    GROUP BY daily_date
    ORDER BY daily_date DESC
    LIMIT ${input.limit}
  ` as readonly { daily_date: string }[];
  return { dates: rows.map((row) => row.daily_date) };
}

export async function listTaskRuns(
  sql: LivePostgresSql,
  pageId: string,
  input: { cursor?: string; limit: number },
): Promise<PlannerTaskRunPageDto | null> {
  const cursor = input.cursor ? decodeCursor(input.cursor, "run") : null;
  const updatedAt = cursor?.first ?? null;
  const cursorId = cursor?.second ?? "";
  const rows = await sql`
    WITH work_task AS (
      SELECT CASE b.block_type
               WHEN 'task_ref' THEN NULLIF(BTRIM(b.properties->>'taskId'), '')
               WHEN 'runbook_ref' THEN NULLIF(BTRIM(b.properties->>'runbookId'), '')
             END AS task_id
      FROM blocks b
      JOIN pages p ON p.id = b.page_id AND p.archived = FALSE
      WHERE b.page_id = ${pageId}
        AND b.block_type IN ('task_ref', 'runbook_ref')
        AND COALESCE((b.properties->>'primary')::boolean, FALSE)
        AND NULLIF(BTRIM(CASE b.block_type
          WHEN 'task_ref' THEN b.properties->>'taskId'
          WHEN 'runbook_ref' THEN b.properties->>'runbookId'
        END), '') IS NOT NULL
      ORDER BY CASE b.block_type WHEN 'task_ref' THEN 0 ELSE 1 END,
               b.position_key,
               b.id
      LIMIT 1
    ),
    all_runs AS (
      SELECT session.session_id,
             session.updated_at,
             to_char(
               session.updated_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) AS updated_at_cursor
      FROM work_task task
      JOIN board_items item
        ON item.container_kind = 'task'
       AND item.container_id = task.task_id
       AND item.item_type = 'session'
      JOIN sessions session ON session.session_id = item.item_id
    ),
    paged_runs AS (
      SELECT *
      FROM all_runs
      WHERE (
        ${updatedAt}::text IS NULL
        OR (updated_at, session_id) < (${updatedAt}::timestamptz, ${cursorId})
      )
      ORDER BY updated_at DESC, session_id DESC
      LIMIT ${input.limit + 1}
    )
    SELECT task.task_id,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'agent_session_id', run.session_id,
                 'updated_at_cursor', run.updated_at_cursor
               )
               ORDER BY run.updated_at DESC, run.session_id DESC
             ) FILTER (WHERE run.session_id IS NOT NULL),
             '[]'::jsonb
           ) AS runs,
           (SELECT count(*)::integer FROM all_runs) AS total
    FROM work_task task
    LEFT JOIN paged_runs run ON TRUE
    GROUP BY task.task_id
  ` as readonly TaskRunRow[];
  const row = rows[0];
  if (!row) return null;
  const visible = row.runs.slice(0, input.limit);
  const last = visible.at(-1);
  return {
    items: visible.map((run) => ({ agent_session_id: run.agent_session_id })),
    next_cursor: row.runs.length > input.limit && last
      ? encodeCursor("run", last.updated_at_cursor, last.agent_session_id)
      : null,
    total: Number(row.total),
  };
}

export function decodeMountCursor(
  value: string | undefined,
  scope: "task" | "document",
): PlannerMountCursor | null {
  if (!value) return null;
  const cursor = decodeCursor(value, scope);
  return { position: cursor.first, id: cursor.second };
}

export function encodeMountCursor(
  scope: "task" | "document",
  cursor: PlannerMountCursor | null,
): string | null {
  return cursor ? encodeCursor(scope, cursor.position, cursor.id) : null;
}

function encodeCursor(scope: string, first: string, second: string): string {
  return Buffer.from(JSON.stringify([scope, first, second]), "utf8").toString("base64url");
}

function decodeCursor(
  value: string,
  expectedScope: string,
): { first: string; second: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 3
      || parsed[0] !== expectedScope
      || typeof parsed[1] !== "string"
      || parsed[1].length === 0
      || typeof parsed[2] !== "string"
      || parsed[2].length === 0
    ) {
      throw new Error("shape");
    }
    return { first: parsed[1], second: parsed[2] };
  } catch {
    throw new PlannerCursorError("invalid planner cursor");
  }
}
