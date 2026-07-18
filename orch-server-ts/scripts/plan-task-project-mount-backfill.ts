import postgres from "postgres";

import {
  planTaskProjectMountBackfill,
  type TaskProjectMountInventoryRow,
} from "../src/tasks/task_project_mount_backfill_plan.js";

interface InventoryRow {
  task_id: string;
  task_page_id: string;
  title: string;
  folder_id: string;
  project_page_id: string;
  physical_mount_count: number;
  exact_title_block_count: number;
}

const sql = postgres(requiredEnv("DATABASE_URL"), { max: 1 });

try {
  const inventory = await sql.begin(async (transaction) => {
    await transaction`SET TRANSACTION READ ONLY`;
    return await transaction<InventoryRow[]>`
      SELECT
        task.id AS task_id,
        task.task_page_id,
        task.title,
        folder.id AS folder_id,
        folder.project_page_id,
        COUNT(DISTINCT source.id) FILTER (
          WHERE mount.target_page_id IS NOT NULL
        )::int AS physical_mount_count,
        COUNT(DISTINCT source.id) FILTER (
          WHERE BTRIM(source.text_plain) = ('[[' || task.title || ']]')
        )::int AS exact_title_block_count
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
      JOIN pages project_page
        ON project_page.id = folder.project_page_id
       AND project_page.archived = FALSE
      LEFT JOIN blocks source ON source.page_id = project_page.id
      LEFT JOIN block_links mount
        ON mount.source_block_id = source.id
       AND mount.link_kind = 'mount'
       AND mount.target_page_id = task_page.id
      WHERE task.task_page_id IS NOT NULL
        AND task.archived = FALSE
      GROUP BY
        task.id, task.task_page_id, task.title,
        folder.id, folder.project_page_id
      ORDER BY folder.id, task.title, task.id
    `;
  });
  const plan = planTaskProjectMountBackfill(inventory.map(toInventoryRow));
  process.stdout.write(`${JSON.stringify({
    mode: "dry-run",
    writesEnabled: false,
    total: inventory.length,
    physicalMountMissing: plan.create.length + plan.inspect.length,
    createMount: plan.create,
    inspectUnresolvedTitleBlock: plan.inspect,
    alreadyMountedCount: plan.alreadyMounted.length,
    alreadyMounted: plan.alreadyMounted,
    duplicatePhysicalMount: plan.duplicate,
  }, null, 2)}\n`);
  process.stdout.write("Read-only plan. Apply is intentionally unavailable without separate approval.\n");
} finally {
  await sql.end();
}

function toInventoryRow(row: InventoryRow): TaskProjectMountInventoryRow {
  return {
    taskId: row.task_id,
    taskPageId: row.task_page_id,
    title: row.title,
    folderId: row.folder_id,
    projectPageId: row.project_page_id,
    physicalMountCount: Number(row.physical_mount_count),
    exactTitleBlockCount: Number(row.exact_title_block_count),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
