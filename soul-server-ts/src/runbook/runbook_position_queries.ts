import type { RepositorySql } from "../db/repositories/repository_helpers.js";
import { requireOne } from "./runbook_models.js";

export async function resolveSectionPositionTx(
  sql: RepositorySql,
  runbookId: string,
  params: { afterSectionId?: string | null; beforeSectionId?: string | null },
): Promise<{ lower: string | null; upper: string | null }> {
  const explicit = await getExplicitPositionBounds(
    sql,
    "runbook_sections",
    "runbook_id",
    runbookId,
    params.afterSectionId,
    params.beforeSectionId,
  );
  if (explicit) return explicit;
  return { lower: await lastSectionPosition(sql, runbookId), upper: null };
}

export async function resolveItemPositionTx(
  sql: RepositorySql,
  sectionId: string,
  params: { afterItemId?: string | null; beforeItemId?: string | null },
): Promise<{ lower: string | null; upper: string | null }> {
  const explicit = await getExplicitPositionBounds(
    sql,
    "runbook_items",
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
  runbookId: string,
): Promise<string | null> {
  const rows = await sql<Array<{ position_key: string }>>`
    SELECT position_key
    FROM runbook_sections
    WHERE runbook_id = ${runbookId}
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
    FROM runbook_items
    WHERE section_id = ${sectionId}
    ORDER BY position_key DESC
    LIMIT 1
  `;
  return rows[0]?.position_key ?? null;
}

async function getExplicitPositionBounds(
  sql: RepositorySql,
  table: "runbook_sections" | "runbook_items",
  parentColumn: "runbook_id" | "section_id",
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
  table: "runbook_sections" | "runbook_items",
  parentColumn: "runbook_id" | "section_id",
  parentId: string,
  id: string,
): Promise<string> {
  const rows =
    table === "runbook_sections"
      ? await sql<Array<{ position_key: string }>>`
          SELECT position_key FROM runbook_sections
          WHERE id = ${id} AND runbook_id = ${parentId}
        `
      : await sql<Array<{ position_key: string }>>`
          SELECT position_key FROM runbook_items
          WHERE id = ${id} AND section_id = ${parentId}
        `;
  return requireOne(rows, `${table}.${parentColumn} position`).position_key;
}
