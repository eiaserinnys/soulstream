import type { LivePostgresSql } from "../runtime/live_db_sql.js";
import { serializeCardRow } from "../folders/folder_contracts.js";
import type { PlannerFolderDto } from "./planner_contract.js";
import { pageDto } from "./planner_repository_reads.js";

/** One batch over folder identities, independent of card visibility and link block types. */
export async function loadPlannerFolders(sql: LivePostgresSql, folderIds: string[]): Promise<PlannerFolderDto[]> {
  if (!folderIds.length) return [];
  const rows = await sql`
    WITH selected AS (SELECT * FROM folders WHERE id = ANY(${folderIds}::text[])),
    status_counts AS (
      SELECT c.folder_id, c.status, COUNT(*)::integer AS count
      FROM cards c JOIN selected f ON f.id = c.folder_id
      WHERE NOT c.archived GROUP BY c.folder_id, c.status
    ), counts AS (
      SELECT folder_id, jsonb_object_agg(status, count) AS item_counts,
        SUM(count)::integer AS item_total,
        COALESCE(SUM(count) FILTER (WHERE status = 'done'), 0)::integer AS completed_item_count
      FROM status_counts GROUP BY folder_id
    ), preferred AS (
      SELECT DISTINCT ON (c.folder_id) c.folder_id,
        COALESCE(c.assignee_agent_id, c.assignee_user_id,
          CASE WHEN c.assignee_session_id IS NOT NULL THEN '세션 담당' END) AS assignee
      FROM cards c JOIN selected f ON f.id = c.folder_id
      WHERE NOT c.archived
      ORDER BY c.folder_id, CASE c.status WHEN 'running' THEN 0 WHEN 'review' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
        c.position_key COLLATE "C", c.id
    )
    SELECT to_jsonb(f) AS folder, to_jsonb(p) - 'snapshot' - 'state_vector' AS page,
      COALESCE(c.item_counts, '{}'::jsonb) AS item_counts, COALESCE(c.item_total, 0) AS item_total,
      COALESCE(c.completed_item_count, 0) AS completed_item_count, a.assignee
    FROM selected f JOIN pages p ON p.id = f.project_page_id
    LEFT JOIN counts c ON c.folder_id = f.id LEFT JOIN preferred a ON a.folder_id = f.id
    WHERE NOT f.archived AND NOT p.archived AND f.id NOT IN ('claude', 'llm')
    ORDER BY array_position(${folderIds}::text[], f.id)
  `;
  return rows.map(row => ({ folder: serializeCardRow(row.folder as Record<string, unknown>),
    page: pageDto(row.page as Record<string, unknown>), itemCounts: row.item_counts as Record<string, number>,
    itemTotal: Number(row.item_total), completedItemCount: Number(row.completed_item_count), assignee: row.assignee as string | null }));
}
