import postgres from "postgres";

import {
  planTaskCrudSyncAudit,
  type ActiveTaskProjectMountRow,
  type ArchivedTaskMountRow,
} from "../src/tasks/task_crud_sync_audit_plan.js";

interface ActiveInventoryRow {
  task_id: string;
  task_page_id: string;
  title: string;
  expected_folder_id: string;
  expected_project_page_id: string;
  source_project_page_id: string | null;
  mount_count: number;
}

interface ArchivedInventoryRow {
  task_id: string;
  task_page_id: string;
  title: string;
  source_page_id: string;
  source_kind: "project" | "daily" | "other";
  mount_count: number;
}

const sql = postgres(requiredEnv("DATABASE_URL"), { max: 1 });

try {
  const inventory = await sql.begin(async (transaction) => {
    await transaction`SET TRANSACTION READ ONLY`;
    const activeRows = await transaction<ActiveInventoryRow[]>`
      WITH identities AS (
        SELECT
          task.id AS task_id,
          task.task_page_id,
          task.title,
          board_item.folder_id AS expected_folder_id,
          folder.project_page_id AS expected_project_page_id
        FROM tasks task
        JOIN board_items board_item
          ON board_item.id = task.board_item_id
         AND board_item.item_type = 'task'
         AND board_item.item_id = task.id
         AND board_item.container_kind = 'folder'
         AND board_item.membership_kind = 'primary'
        JOIN folders folder
          ON folder.id = board_item.folder_id
         AND folder.project_page_id IS NOT NULL
         AND folder.archived = FALSE
        JOIN pages task_page
          ON task_page.id = task.task_page_id
         AND task_page.archived = FALSE
        WHERE task.archived = FALSE
      ), project_mounts AS (
        SELECT
          link.target_page_id AS task_page_id,
          source.page_id AS source_project_page_id,
          COUNT(DISTINCT source.id)::int AS mount_count
        FROM block_links link
        JOIN blocks source ON source.id = link.source_block_id
        JOIN folders source_folder ON source_folder.project_page_id = source.page_id
        WHERE link.link_kind = 'mount'
        GROUP BY link.target_page_id, source.page_id
      )
      SELECT
        identity.task_id,
        identity.task_page_id,
        identity.title,
        identity.expected_folder_id,
        identity.expected_project_page_id,
        mount.source_project_page_id,
        COALESCE(mount.mount_count, 0)::int AS mount_count
      FROM identities identity
      LEFT JOIN project_mounts mount ON mount.task_page_id = identity.task_page_id
      ORDER BY identity.task_id, mount.source_project_page_id
    `;
    const archivedRows = await transaction<ArchivedInventoryRow[]>`
      SELECT
        task.id AS task_id,
        task.task_page_id,
        task.title,
        source.page_id AS source_page_id,
        CASE
          WHEN project_folder.id IS NOT NULL THEN 'project'
          WHEN source_page.daily_date IS NOT NULL THEN 'daily'
          ELSE 'other'
        END AS source_kind,
        COUNT(DISTINCT source.id)::int AS mount_count
      FROM tasks task
      JOIN pages task_page ON task_page.id = task.task_page_id
      JOIN block_links link
        ON link.target_page_id = task_page.id
       AND link.link_kind = 'mount'
      JOIN blocks source ON source.id = link.source_block_id
      JOIN pages source_page ON source_page.id = source.page_id
      LEFT JOIN folders project_folder ON project_folder.project_page_id = source.page_id
      WHERE task.archived = TRUE OR task_page.archived = TRUE
      GROUP BY
        task.id, task.task_page_id, task.title,
        source.page_id, source_page.daily_date, project_folder.id
      ORDER BY task.id, source.page_id
    `;
    return { activeRows, archivedRows };
  });
  const plan = planTaskCrudSyncAudit({
    activeRows: inventory.activeRows.map(toActiveRow),
    archivedRows: inventory.archivedRows.map(toArchivedRow),
  });
  process.stdout.write(`${JSON.stringify({
    mode: "dry-run",
    writesEnabled: false,
    ...plan,
  }, null, 2)}\n`);
  process.stdout.write("Read-only audit. Apply is intentionally unavailable.\n");
} finally {
  await sql.end();
}

function toActiveRow(row: ActiveInventoryRow): ActiveTaskProjectMountRow {
  return {
    taskId: row.task_id,
    taskPageId: row.task_page_id,
    title: row.title,
    expectedFolderId: row.expected_folder_id,
    expectedProjectPageId: row.expected_project_page_id,
    sourceProjectPageId: row.source_project_page_id,
    mountCount: Number(row.mount_count),
  };
}

function toArchivedRow(row: ArchivedInventoryRow): ArchivedTaskMountRow {
  return {
    taskId: row.task_id,
    taskPageId: row.task_page_id,
    title: row.title,
    sourcePageId: row.source_page_id,
    sourceKind: row.source_kind,
    mountCount: Number(row.mount_count),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
