import type { RepositorySql } from "./task_types.js";
import { requireOne } from "./task_models.js";

export async function resolveSectionPositionTx(
  sql: RepositorySql,
  folderId: string,
  params: { afterSectionId?: string | null; beforeSectionId?: string | null },
): Promise<{ lower: string | null; upper: string | null }> {
  const explicit = await getExplicitPositionBounds(
    sql,
    "checklist_sections",
    "folder_id",
    folderId,
    params.afterSectionId,
    params.beforeSectionId,
  );
  if (explicit) return explicit;
  return { lower: await lastSectionPosition(sql, folderId), upper: null };
}

export async function resolveItemPositionTx(
  sql: RepositorySql,
  sectionId: string,
  params: { afterItemId?: string | null; beforeItemId?: string | null },
): Promise<{ lower: string | null; upper: string | null }> {
  const explicit = await getExplicitPositionBounds(
    sql,
    "checklist_items",
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
  folderId: string,
): Promise<string | null> {
  const rows = await sql<Array<{ position_key: string }>>`
    SELECT position_key
    FROM checklist_sections
    WHERE folder_id = ${folderId}
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
    FROM checklist_items
    WHERE section_id = ${sectionId}
    ORDER BY position_key DESC
    LIMIT 1
  `;
  return rows[0]?.position_key ?? null;
}

async function getExplicitPositionBounds(
  sql: RepositorySql,
  table: "checklist_sections" | "checklist_items",
  parentColumn: "folder_id" | "section_id",
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
  table: "checklist_sections" | "checklist_items",
  parentColumn: "folder_id" | "section_id",
  parentId: string,
  id: string,
): Promise<string> {
  const rows =
    table === "checklist_sections"
      ? await sql<Array<{ position_key: string }>>`
          SELECT position_key FROM checklist_sections
          WHERE id = ${id} AND folder_id = ${parentId}
        `
      : await sql<Array<{ position_key: string }>>`
          SELECT position_key FROM checklist_items
          WHERE id = ${id} AND section_id = ${parentId}
        `;
  return requireOne(rows, `${table}.${parentColumn} position`).position_key;
}
