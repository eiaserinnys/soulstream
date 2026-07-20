import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import type { PlannerPageSlice, PlannerTaskDto } from "./planner_contract.js";
import { decodeCursor, encodeCursor } from "./planner_repository_reads.js";

interface FullStarredTaskRow extends Record<string, unknown> {
  id: string;
  updated_at_cursor: string;
  has_more: boolean;
  payload: PlannerTaskDto;
}

// Production-gated legacy runbook_ref reads: docs/task-read-compatibility.md
export async function listFullStarredTasks(
  sql: LivePostgresSql,
  input: { cursor?: string; limit: number },
): Promise<PlannerPageSlice<PlannerTaskDto>> {
  const cursor = input.cursor ? decodeCursor(input.cursor, "starred-task") : null;
  const updatedAt = cursor?.first ?? null;
  const cursorId = cursor?.second ?? "";
  const rows = await sql`
    WITH starred_rows AS (
      SELECT page.id AS page_id,
             page.updated_at,
             to_char(page.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               AS updated_at_cursor,
             identity.task_id,
             project_mount.project_page_id
      FROM pages page
      JOIN LATERAL (
        SELECT CASE block.block_type
                 WHEN 'task_ref' THEN NULLIF(BTRIM(block.properties->>'taskId'), '')
                 WHEN 'runbook_ref' THEN NULLIF(BTRIM(block.properties->>'runbookId'), '')
               END AS task_id
        FROM blocks block
        WHERE block.page_id = page.id
          AND block.block_type IN ('task_ref', 'runbook_ref')
          AND COALESCE((block.properties->>'primary')::boolean, FALSE)
          AND NULLIF(BTRIM(CASE block.block_type
            WHEN 'task_ref' THEN block.properties->>'taskId'
            WHEN 'runbook_ref' THEN block.properties->>'runbookId'
          END), '') IS NOT NULL
        ORDER BY CASE block.block_type WHEN 'task_ref' THEN 0 ELSE 1 END,
                 block.position_key,
                 block.id
        LIMIT 1
      ) identity ON TRUE
      LEFT JOIN LATERAL (
        SELECT project.id AS project_page_id
        FROM pages project
        JOIN blocks source ON source.page_id = project.id
        JOIN block_links link
          ON link.source_block_id = source.id
         AND link.link_kind = 'mount'
         AND link.target_page_id = page.id
        WHERE project.archived = FALSE
          AND project.daily_date IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM blocks project_identity
            WHERE project_identity.page_id = project.id
              AND project_identity.block_type IN ('task_ref', 'runbook_ref')
              AND COALESCE((project_identity.properties->>'primary')::boolean, FALSE)
          )
        ORDER BY project.updated_at DESC, project.id
        LIMIT 1
      ) project_mount ON TRUE
      WHERE page.archived = FALSE
        AND page.daily_date IS NULL
        AND COALESCE((page.metadata->>'starred')::boolean, FALSE)
        AND (
          ${updatedAt}::text IS NULL
          OR (page.updated_at, page.id) < (${updatedAt}::timestamptz, ${cursorId})
        )
      ORDER BY page.updated_at DESC, page.id DESC
      LIMIT ${input.limit + 1}
    ),
    visible_rows AS (
      SELECT * FROM starred_rows
      ORDER BY updated_at DESC, page_id DESC
      LIMIT ${input.limit}
    ),
    mounted_document_rows AS (
      SELECT source.page_id, source.id AS block_id, source.position_key, target.id AS target_page_id
      FROM visible_rows task
      JOIN blocks source ON source.page_id = task.page_id
      JOIN block_links link
        ON link.source_block_id = source.id
       AND link.link_kind = 'mount'
      JOIN pages target
        ON target.id = link.target_page_id
       AND target.archived = FALSE
    ),
    relevant_page_ids AS (
      SELECT page_id FROM visible_rows
      UNION SELECT project_page_id FROM visible_rows WHERE project_page_id IS NOT NULL
      UNION SELECT target_page_id FROM mounted_document_rows
    ),
    page_payloads AS (
      SELECT page.id,
             jsonb_build_object(
               'id', page.id,
               'title', page.title,
               'daily_date', page.daily_date::text,
               'version', page.version,
               'archived', page.archived,
               'metadata', page.metadata,
               'created_at', page.created_at,
               'updated_at', page.updated_at
             ) AS payload
      FROM pages page
      JOIN relevant_page_ids relevant ON relevant.page_id = page.id
    ),
    page_blocks AS (
      SELECT block.page_id,
             jsonb_agg(
               jsonb_build_object(
                 'id', block.id,
                 'page_id', block.page_id,
                 'parent_id', block.parent_id,
                 'position_key', block.position_key,
                 'block_type', block.block_type,
                 'text', block.text_plain,
                 'properties', block.properties,
                 'collapsed', block.collapsed
               ) ORDER BY block.position_key, block.id
             ) AS payload
      FROM blocks block
      JOIN visible_rows task ON task.page_id = block.page_id
      GROUP BY block.page_id
    ),
    task_ids AS (
      SELECT DISTINCT task_id FROM visible_rows
    ),
    task_item_status_counts AS (
      SELECT section.task_id, item.status, count(*)::integer AS status_count
      FROM task_sections section
      JOIN task_ids selected ON selected.task_id = section.task_id
      JOIN task_items item ON item.section_id = section.id
      WHERE section.archived = FALSE AND item.archived = FALSE
      GROUP BY section.task_id, item.status
    ),
    task_item_counts AS (
      SELECT task_id,
             sum(status_count)::integer AS item_total,
             COALESCE(sum(status_count) FILTER (WHERE status = 'completed'), 0)::integer
               AS completed_item_count,
             jsonb_object_agg(status, status_count) AS item_counts
      FROM task_item_status_counts
      GROUP BY task_id
    ),
    preferred_assignees AS (
      SELECT DISTINCT ON (section.task_id)
             section.task_id,
             COALESCE(
               item.assignee_agent_id,
               item.assignee_user_id,
               CASE WHEN item.assignee_session_id IS NOT NULL THEN '세션 담당' END,
               section.assignee_agent_id,
               section.assignee_user_id,
               CASE WHEN section.assignee_session_id IS NOT NULL THEN '세션 담당' END
             ) AS assignee
      FROM task_sections section
      JOIN task_ids selected ON selected.task_id = section.task_id
      LEFT JOIN task_items item ON item.section_id = section.id AND item.archived = FALSE
      WHERE section.archived = FALSE
      ORDER BY section.task_id,
               CASE item.status
                 WHEN 'in_progress' THEN 0
                 WHEN 'review' THEN 1
                 WHEN 'pending' THEN 2
                 ELSE 3
               END,
               section.position_key,
               item.position_key
    ),
    task_summaries AS (
      SELECT task.id,
             jsonb_build_object(
               'id', task.id,
               'board_item_id', task.board_item_id,
               'title', task.title,
               'status', task.status,
               'archived', task.archived,
               'version', task.version,
               'created_session_id', task.created_session_id,
               'created_event_id', task.created_event_id,
               'created_at', task.created_at,
               'updated_at', task.updated_at,
               'item_counts', COALESCE(counts.item_counts, '{}'::jsonb),
               'item_total', COALESCE(counts.item_total, 0),
               'completed_item_count', COALESCE(counts.completed_item_count, 0),
               'assignee', assignee.assignee
             ) AS payload
      FROM tasks task
      JOIN task_ids selected ON selected.task_id = task.id
      LEFT JOIN task_item_counts counts ON counts.task_id = task.id
      LEFT JOIN preferred_assignees assignee ON assignee.task_id = task.id
      WHERE task.archived = FALSE
    ),
    task_sessions AS (
      SELECT selected.task_id,
             CASE WHEN latest.payload IS NULL
               THEN '[]'::jsonb
               ELSE jsonb_build_array(latest.payload)
             END AS payload
      FROM task_ids selected
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object(
                 'agent_session_id', session.session_id,
                 'folder_id', session.folder_id,
                 'display_name', session.display_name,
                 'node_id', session.node_id,
                 'session_type', session.session_type,
                 'status', session.status,
                 'agent_id', session.agent_id,
                 'predecessor_session_id', session.predecessor_session_id,
                 'review_state', session.review_state,
                 'created_at', session.created_at,
                 'updated_at', session.updated_at
               ) AS payload
        FROM board_items item
        JOIN sessions session ON session.session_id = item.item_id
        WHERE item.container_kind = 'task'
          AND item.container_id = selected.task_id
          AND item.item_type = 'session'
        ORDER BY session.updated_at DESC, session.session_id DESC
        LIMIT 1
      ) latest ON TRUE
    ),
    mounted_documents AS (
      SELECT document.page_id,
             jsonb_agg(
               jsonb_build_object(
                 'block_id', document.block_id,
                 'page', page.payload
               ) ORDER BY document.position_key, document.block_id
             ) AS payload
      FROM mounted_document_rows document
      JOIN page_payloads page ON page.id = document.target_page_id
      GROUP BY document.page_id
    )
    SELECT task.page_id AS id,
           task.updated_at_cursor,
           (SELECT count(*) FROM starred_rows) > ${input.limit} AS has_more,
           jsonb_build_object(
             'page', page.payload,
             'blocks', COALESCE(blocks.payload, '[]'::jsonb),
             'task_id', task.task_id,
             'task', summary.payload,
             'project_page_id', task.project_page_id,
             'sessions', COALESCE(sessions.payload, '[]'::jsonb),
             'mounted_documents', COALESCE(documents.payload, '[]'::jsonb)
           ) AS payload
    FROM visible_rows task
    JOIN page_payloads page ON page.id = task.page_id
    LEFT JOIN page_blocks blocks ON blocks.page_id = task.page_id
    LEFT JOIN task_summaries summary ON summary.id = task.task_id
    LEFT JOIN task_sessions sessions ON sessions.task_id = task.task_id
    LEFT JOIN mounted_documents documents ON documents.page_id = task.page_id
    ORDER BY task.updated_at DESC, task.page_id DESC
  ` as readonly FullStarredTaskRow[];
  const last = rows.at(-1);
  return {
    items: rows.map((row) => row.payload),
    next_cursor: rows[0]?.has_more && last
      ? encodeCursor("starred-task", last.updated_at_cursor, last.id)
      : null,
  };
}
