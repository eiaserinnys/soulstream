import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import type {
  PlannerKind,
  PlannerPayloadRow,
  ProjectReadInput,
} from "./planner_aggregate_types.js";
import { decodeMountCursor } from "./planner_repository_reads.js";
export async function plannerQuery(
  sql: LivePostgresSql,
  kind: PlannerKind,
  selector: string,
  input: ProjectReadInput,
): Promise<readonly PlannerPayloadRow[]> {
  const dailyDate = kind === "today" ? selector : "0001-01-01";
  const taskCursor = decodeMountCursor(input.taskCursor, "task");
  const documentCursor = decodeMountCursor(input.documentCursor, "document");
  return await sql`
    WITH root_page AS (
      SELECT p.*
      FROM pages p
      WHERE p.archived = FALSE
        AND (
          (${kind} = 'today' AND p.daily_date = ${dailyDate}::date)
          OR (${kind} = 'project' AND p.id = ${selector})
        )
      LIMIT 1
    ),
    root_folder AS (
      SELECT folder.id
      FROM root_page root
      JOIN folders folder ON (
        COALESCE(NULLIF(root.metadata->>'folderId', ''),
                 NULLIF(root.metadata->>'folder_id', '')) = folder.id
        OR (
          NULLIF(root.metadata->>'folderId', '') IS NULL
          AND NULLIF(root.metadata->>'folder_id', '') IS NULL
          AND btrim(root.title) = btrim(folder.name)
        )
      )
      WHERE ${kind} = 'project'
      ORDER BY (COALESCE(NULLIF(root.metadata->>'folderId', ''),
                         NULLIF(root.metadata->>'folder_id', '')) = folder.id) DESC,
               folder.id
      LIMIT 1
    ),
    root_blocks AS (
      SELECT b.*
      FROM blocks b
      JOIN root_page root ON root.id = b.page_id
    ),
    physical_root_mounts AS (
      SELECT DISTINCT ON (source.id)
             source.id AS source_block_id,
             source.position_key,
             target.id AS page_id
      FROM root_blocks source
      JOIN block_links link
        ON link.source_block_id = source.id
       AND link.link_kind = 'mount'
      JOIN pages target
        ON target.id = link.target_page_id
       AND target.archived = FALSE
      ORDER BY source.id, link.ordinal
    ),
    folder_task_mounts AS (
      SELECT board_item.id AS source_block_id,
             '~board:' || board_item.id AS position_key,
             runbook.task_page_id AS page_id
      FROM root_folder folder
      JOIN board_items board_item ON board_item.folder_id = folder.id
       AND board_item.container_kind = 'folder'
       AND board_item.container_id = folder.id
       AND board_item.membership_kind = 'primary'
       AND board_item.item_type = 'runbook'
      JOIN runbooks runbook ON runbook.id = board_item.item_id
       AND runbook.board_item_id = board_item.id
       AND runbook.task_page_id IS NOT NULL
       AND runbook.archived = FALSE
      JOIN pages task_page ON task_page.id = runbook.task_page_id
                          AND task_page.archived = FALSE
      WHERE NOT EXISTS (
        SELECT 1
        FROM physical_root_mounts mounted
        WHERE mounted.page_id = runbook.task_page_id
      )
    ),
    root_mounts AS (
      SELECT * FROM physical_root_mounts
      UNION ALL
      SELECT * FROM folder_task_mounts
    ),
    mounted_pages AS (
      SELECT target.*, mount.source_block_id, mount.position_key AS mount_position
      FROM root_mounts mount
      JOIN pages target ON target.id = mount.page_id
    ),
    mounted_kinds AS (
      SELECT mounted.id AS page_id,
             runbook_ref.properties->>'runbookId' AS runbook_id
      FROM mounted_pages mounted
      LEFT JOIN LATERAL (
        SELECT b.properties
        FROM blocks b
        WHERE b.page_id = mounted.id
          AND b.block_type = 'runbook_ref'
          AND COALESCE((b.properties->>'primary')::boolean, FALSE)
          AND NULLIF(b.properties->>'runbookId', '') IS NOT NULL
        ORDER BY b.position_key, b.id
        LIMIT 1
      ) runbook_ref ON TRUE
    ),
    project_pages AS (
      SELECT p.*
      FROM pages p
      WHERE p.archived = FALSE
        AND p.daily_date IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM blocks task_ref
          WHERE task_ref.page_id = p.id
            AND task_ref.block_type = 'runbook_ref'
            AND COALESCE((task_ref.properties->>'primary')::boolean, FALSE)
            AND NULLIF(task_ref.properties->>'runbookId', '') IS NOT NULL
        )
        AND EXISTS (
          SELECT 1
          FROM blocks source
          JOIN block_links project_link
            ON project_link.source_block_id = source.id
           AND project_link.link_kind = 'mount'
          WHERE source.page_id = p.id
        )
    ),
    task_rows AS (
      SELECT mounted.id AS page_id,
             mounted.mount_position,
             kind_row.runbook_id,
             CASE
               WHEN ${kind} = 'project' THEN root.id
               ELSE project_mount.project_page_id
             END AS project_page_id
      FROM mounted_pages mounted
      JOIN mounted_kinds kind_row
        ON kind_row.page_id = mounted.id
       AND kind_row.runbook_id IS NOT NULL
      CROSS JOIN root_page root
      LEFT JOIN LATERAL (
        SELECT project.id AS project_page_id
        FROM project_pages project
        JOIN blocks source ON source.page_id = project.id
        JOIN block_links link
          ON link.source_block_id = source.id
         AND link.link_kind = 'mount'
         AND link.target_page_id = mounted.id
        ORDER BY project.updated_at DESC, project.id
        LIMIT 1
      ) project_mount ON TRUE
      WHERE (
        ${kind} = 'today'
        OR (
          ${input.includeTasks}
          AND (
            ${taskCursor?.position ?? null}::text IS NULL
            OR (mounted.mount_position, mounted.id) < (
              ${taskCursor?.position ?? ""},
              ${taskCursor?.id ?? ""}
            )
          )
        )
      )
      ORDER BY mounted.mount_position DESC, mounted.id DESC
      LIMIT ${kind === "today" ? null : input.taskLimit + 1}
    ),
    visible_task_rows AS (
      SELECT * FROM task_rows
      ORDER BY mount_position DESC, page_id DESC
      LIMIT ${kind === "today" ? null : input.taskLimit}
    ),
    document_rows AS (
      SELECT mounted.id AS page_id,
             mounted.mount_position
      FROM mounted_pages mounted
      JOIN mounted_kinds kind_row ON kind_row.page_id = mounted.id
      WHERE ${kind} = 'project'
        AND ${input.includeDocuments}
        AND kind_row.runbook_id IS NULL
        AND (
          ${documentCursor?.position ?? null}::text IS NULL
          OR (mounted.mount_position, mounted.id) < (
            ${documentCursor?.position ?? ""},
            ${documentCursor?.id ?? ""}
          )
        )
      ORDER BY mounted.mount_position DESC, mounted.id DESC
      LIMIT ${input.documentLimit + 1}
    ),
    visible_document_rows AS (
      SELECT * FROM document_rows
      ORDER BY mount_position DESC, page_id DESC
      LIMIT ${input.documentLimit}
    ),
    relevant_page_ids AS (
      SELECT id FROM root_page
      UNION SELECT page_id FROM visible_task_rows
      UNION SELECT page_id FROM visible_document_rows
      UNION SELECT project_page_id FROM visible_task_rows WHERE project_page_id IS NOT NULL
      UNION
      SELECT link.target_page_id
      FROM visible_task_rows task
      JOIN blocks source ON source.page_id = task.page_id
      JOIN block_links link
        ON link.source_block_id = source.id
       AND link.link_kind = 'mount'
      WHERE link.target_page_id IS NOT NULL
    ),
    page_payloads AS (
      SELECT p.id,
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
      JOIN relevant_page_ids relevant ON relevant.id = p.id
    ),
    block_payloads AS (
      SELECT b.id,
             b.page_id,
             b.position_key,
             jsonb_build_object(
               'id', b.id,
               'page_id', b.page_id,
               'parent_id', b.parent_id,
               'position_key', b.position_key,
               'block_type', b.block_type,
               'text', b.text_plain,
               'properties', b.properties,
               'collapsed', b.collapsed
             ) AS payload
      FROM blocks b
      WHERE b.page_id IN (
        SELECT id FROM root_page
        UNION SELECT page_id FROM visible_task_rows
      )
    ),
    page_blocks AS (
      SELECT block.page_id,
             jsonb_agg(block.payload ORDER BY block.position_key, block.id) AS payload
      FROM block_payloads block
      GROUP BY block.page_id
    ),
    task_runbook_ids AS (
      SELECT DISTINCT runbook_id FROM visible_task_rows
    ),
    runbook_item_status_counts AS (
      SELECT section.runbook_id,
             item.status,
             count(*)::integer AS status_count
      FROM runbook_sections section
      JOIN task_runbook_ids task_runbook ON task_runbook.runbook_id = section.runbook_id
      JOIN runbook_items item ON item.section_id = section.id
      WHERE section.archived = FALSE AND item.archived = FALSE
      GROUP BY section.runbook_id, item.status
    ),
    runbook_item_counts AS (
      SELECT runbook_id,
             sum(status_count)::integer AS item_total,
             COALESCE(
               sum(status_count) FILTER (WHERE status = 'completed'),
               0
             )::integer AS completed_item_count,
             jsonb_object_agg(status, status_count) AS item_counts
      FROM runbook_item_status_counts
      GROUP BY runbook_id
    ),
    preferred_assignees AS (
      SELECT DISTINCT ON (section.runbook_id)
             section.runbook_id,
             COALESCE(
               item.assignee_agent_id,
               item.assignee_user_id,
               CASE WHEN item.assignee_session_id IS NOT NULL THEN '세션 담당' END,
               section.assignee_agent_id,
               section.assignee_user_id,
               CASE WHEN section.assignee_session_id IS NOT NULL THEN '세션 담당' END
             ) AS assignee
      FROM runbook_sections section
      JOIN task_runbook_ids task_runbook ON task_runbook.runbook_id = section.runbook_id
      LEFT JOIN runbook_items item
        ON item.section_id = section.id
       AND item.archived = FALSE
      WHERE section.archived = FALSE
      ORDER BY section.runbook_id,
               CASE item.status
                 WHEN 'in_progress' THEN 0
                 WHEN 'review' THEN 1
                 WHEN 'pending' THEN 2
                 ELSE 3
               END,
               section.position_key,
               item.position_key
    ),
    runbook_summaries AS (
      SELECT runbook.id,
             jsonb_build_object(
               'id', runbook.id,
               'board_item_id', runbook.board_item_id,
               'title', runbook.title,
               'status', runbook.status,
               'archived', runbook.archived,
               'version', runbook.version,
               'created_session_id', runbook.created_session_id,
               'created_event_id', runbook.created_event_id,
               'created_at', runbook.created_at,
               'updated_at', runbook.updated_at,
               'item_counts', COALESCE(counts.item_counts, '{}'::jsonb),
               'item_total', COALESCE(counts.item_total, 0),
               'completed_item_count', COALESCE(counts.completed_item_count, 0),
               'assignee', assignee.assignee
             ) AS payload
      FROM runbooks runbook
      JOIN task_runbook_ids task_runbook ON task_runbook.runbook_id = runbook.id
      LEFT JOIN runbook_item_counts counts ON counts.runbook_id = runbook.id
      LEFT JOIN preferred_assignees assignee ON assignee.runbook_id = runbook.id
      WHERE runbook.archived = FALSE
    ),
    runbook_sessions AS (
      SELECT task_runbook.runbook_id,
             CASE WHEN latest.payload IS NULL
               THEN '[]'::jsonb
               ELSE jsonb_build_array(latest.payload)
             END AS payload
      FROM task_runbook_ids task_runbook
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
        WHERE item.container_kind = 'runbook'
          AND item.container_id = task_runbook.runbook_id
          AND item.item_type = 'session'
        ORDER BY session.updated_at DESC, session.session_id DESC
        LIMIT 1
      ) latest ON TRUE
    ),
    mounted_documents AS (
      SELECT source.page_id,
             jsonb_agg(
               jsonb_build_object(
                 'block_id', source.id,
                 'page', target_payload.payload
               )
               ORDER BY source.position_key, source.id
             ) AS payload
      FROM visible_task_rows task
      JOIN blocks source ON source.page_id = task.page_id
      JOIN block_links link
        ON link.source_block_id = source.id
       AND link.link_kind = 'mount'
      JOIN pages target
        ON target.id = link.target_page_id
       AND target.archived = FALSE
      JOIN page_payloads target_payload ON target_payload.id = target.id
      GROUP BY source.page_id
    ),
    task_payloads AS (
      SELECT task.page_id,
             task.mount_position,
             jsonb_build_object(
               'page', page_payload.payload,
               'blocks', COALESCE(page_block.payload, '[]'::jsonb),
               'runbook_id', task.runbook_id,
               'runbook', runbook.payload,
               'project_page_id', task.project_page_id,
               'sessions', COALESCE(run_sessions.payload, '[]'::jsonb),
               'mounted_documents', COALESCE(documents.payload, '[]'::jsonb)
             ) AS payload
      FROM visible_task_rows task
      JOIN pages page ON page.id = task.page_id
      JOIN page_payloads page_payload ON page_payload.id = page.id
      LEFT JOIN page_blocks page_block ON page_block.page_id = page.id
      LEFT JOIN runbook_summaries runbook ON runbook.id = task.runbook_id
      LEFT JOIN runbook_sessions run_sessions ON run_sessions.runbook_id = task.runbook_id
      LEFT JOIN mounted_documents documents ON documents.page_id = page.id
    ),
    payload AS (
      SELECT CASE
        WHEN root.id IS NULL THEN NULL
        WHEN ${kind} = 'today' THEN jsonb_build_object(
          'daily', jsonb_build_object(
            'page', root_payload.payload,
            'blocks', COALESCE(root_block_payload.payload, '[]'::jsonb),
            'state_vector', ''
          ),
          'projects', COALESCE((
            SELECT jsonb_agg(project_payload.payload ORDER BY project.updated_at DESC, project.id)
            FROM (
              SELECT DISTINCT project_page_id
              FROM visible_task_rows
              WHERE project_page_id IS NOT NULL
            ) task_project
            JOIN project_pages project ON project.id = task_project.project_page_id
            JOIN page_payloads project_payload ON project_payload.id = project.id
          ), '[]'::jsonb),
          'memo_blocks', COALESCE((
            SELECT jsonb_agg(block_payload.payload ORDER BY block.position_key, block.id)
            FROM root_blocks block
            JOIN block_payloads block_payload ON block_payload.id = block.id
            WHERE block.block_type = 'paragraph'
              AND NOT EXISTS (
                SELECT 1 FROM block_links link
                WHERE link.source_block_id = block.id AND link.link_kind = 'mount'
              )
          ), '[]'::jsonb),
          'review_session_ids', COALESCE((
            SELECT jsonb_agg(review.session_id ORDER BY review.updated_at DESC, review.session_id DESC)
            FROM (
              SELECT session.session_id, session.updated_at
              FROM sessions session
              WHERE session.review_state = 'needs_review'
              ORDER BY session.updated_at DESC, session.session_id DESC
              LIMIT 50
            ) review
          ), '[]'::jsonb),
          'tasks', COALESCE((
            SELECT jsonb_agg(task.payload ORDER BY task.mount_position ASC, task.page_id)
            FROM task_payloads task
          ), '[]'::jsonb)
        )
        ELSE jsonb_build_object(
          'project', root_payload.payload,
          'tasks', COALESCE((
            SELECT jsonb_agg(task.payload ORDER BY task.mount_position DESC, task.page_id)
            FROM task_payloads task
          ), '[]'::jsonb),
          'documents', COALESCE((
            SELECT jsonb_agg(page_payload.payload ORDER BY document.mount_position DESC, page.id)
            FROM visible_document_rows document
            JOIN pages page ON page.id = document.page_id
            JOIN page_payloads page_payload ON page_payload.id = page.id
          ), '[]'::jsonb)
        )
      END AS payload
      FROM (SELECT 1) singleton
      LEFT JOIN root_page root ON TRUE
      LEFT JOIN page_payloads root_payload ON root_payload.id = root.id
      LEFT JOIN page_blocks root_block_payload ON root_block_payload.page_id = root.id
    )
    SELECT payload,
           CASE WHEN ${kind} = 'project'
                  AND (SELECT count(*) FROM task_rows) > ${input.taskLimit}
             THEN (
               SELECT mount_position FROM visible_task_rows
               ORDER BY mount_position ASC, page_id ASC LIMIT 1
             )
             ELSE NULL
           END AS next_task_position,
           CASE WHEN ${kind} = 'project'
                  AND (SELECT count(*) FROM task_rows) > ${input.taskLimit}
             THEN (
               SELECT page_id FROM visible_task_rows
               ORDER BY mount_position ASC, page_id ASC LIMIT 1
             )
             ELSE NULL
           END AS next_task_id,
           CASE WHEN ${kind} = 'project'
                  AND (SELECT count(*) FROM document_rows) > ${input.documentLimit}
             THEN (
               SELECT mount_position FROM visible_document_rows
               ORDER BY mount_position ASC, page_id ASC LIMIT 1
             )
             ELSE NULL
           END AS next_document_position,
           CASE WHEN ${kind} = 'project'
                  AND (SELECT count(*) FROM document_rows) > ${input.documentLimit}
             THEN (
               SELECT page_id FROM visible_document_rows
               ORDER BY mount_position ASC, page_id ASC LIMIT 1
             )
             ELSE NULL
           END AS next_document_id
    FROM payload
  ` as readonly PlannerPayloadRow[];
}
