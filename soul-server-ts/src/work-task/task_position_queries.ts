import type { RepositorySql } from "../db/repositories/repository_helpers.js";
import { requireOne } from "./task_models.js";

export async function resolveSectionPositionTx(
  sql: RepositorySql,
  taskId: string,
  params: { afterSectionId?: string | null; beforeSectionId?: string | null },
): Promise<{ lower: string | null; upper: string | null }> {
  const explicit = await getExplicitPositionBounds(
    sql,
    "task_sections",
    "task_id",
    taskId,
    params.afterSectionId,
    params.beforeSectionId,
  );
  if (explicit) return explicit;
  return { lower: await lastSectionPosition(sql, taskId), upper: null };
}

export async function resolveItemPositionTx(
  sql: RepositorySql,
  sectionId: string,
  params: { afterItemId?: string | null; beforeItemId?: string | null },
): Promise<{ lower: string | null; upper: string | null }> {
  const explicit = await getExplicitPositionBounds(
    sql,
    "task_items",
    "section_id",
    sectionId,
    params.afterItemId,
    params.beforeItemId,
  );
  if (explicit) return explicit;
  return { lower: await lastItemPosition(sql, sectionId), upper: null };
}

async function lastSectionPosition(
  sql: RepositorySql,
  taskId: string,
): Promise<string | null> {
  const rows = await sql<Array<{ position_key: string }>>`
    SELECT position_key
    FROM task_sections
    WHERE task_id = ${taskId}
    ORDER BY position_key DESC
    LIMIT 1
  `;
  return rows[0]?.position_key ?? null;
}

async function lastItemPosition(
  sql: RepositorySql,
  sectionId: string,
): Promise<string | null> {
  const rows = await sql<Array<{ position_key: string }>>`
    SELECT position_key
    FROM task_items
    WHERE section_id = ${sectionId}
    ORDER BY position_key DESC
    LIMIT 1
  `;
  return rows[0]?.position_key ?? null;
}

async function getExplicitPositionBounds(
  sql: RepositorySql,
  table: "task_sections" | "task_items",
  parentColumn: "task_id" | "section_id",
  parentId: string,
  afterId?: string | null,
  beforeId?: string | null,
): Promise<{ lower: string | null; upper: string | null } | null> {
  if (!afterId && !beforeId) return null;
  const lower = afterId
    ? await getPosition(sql, table, parentColumn, parentId, afterId)
    : null;
  const upper = beforeId
    ? await getPosition(sql, table, parentColumn, parentId, beforeId)
    : null;
  return { lower, upper };
}

async function getPosition(
  sql: RepositorySql,
  table: "task_sections" | "task_items",
  parentColumn: "task_id" | "section_id",
  parentId: string,
  id: string,
): Promise<string> {
  const rows =
    table === "task_sections"
      ? await sql<Array<{ position_key: string }>>`
          SELECT position_key FROM task_sections
          WHERE id = ${id} AND task_id = ${parentId}
        `
      : await sql<Array<{ position_key: string }>>`
          SELECT position_key FROM task_items
          WHERE id = ${id} AND section_id = ${parentId}
        `;
  return requireOne(rows, `${table}.${parentColumn} position`).position_key;
}
