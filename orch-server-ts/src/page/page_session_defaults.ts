import type { PageReadQuerySql } from "./page_repository_reads.js";

export interface PageSessionDefaultsDto {
  agentId: string | null;
  nodeId: string | null;
  sourcePageId: string;
  sourceBlockId: string;
}

interface SessionDefaultsRow extends Record<string, unknown> {
  id: string;
  page_id: string;
  position_key: string;
  properties: Record<string, unknown>;
}

interface MountParentRow extends Record<string, unknown> {
  page_id: string;
  block_id: string;
  position_key: string;
}

export async function resolvePageSessionDefaults(
  sql: PageReadQuerySql,
  pageId: string,
  maxPages = 64,
): Promise<PageSessionDefaultsDto | null> {
  const queue: Array<{ pageId: string; entryBlockId: string | null }> = [
    { pageId, entryBlockId: null },
  ];
  const visited = new Set<string>();

  while (queue.length > 0 && visited.size < maxPages) {
    const current = queue.shift();
    if (!current || visited.has(current.pageId)) continue;
    visited.add(current.pageId);

    const candidates = current.entryBlockId === null
      ? await localSessionDefaults(sql, current.pageId)
      : await ancestorSessionDefaults(sql, current.pageId, current.entryBlockId);
    for (const candidate of candidates) {
      const resolved = sessionDefaultsDto(candidate);
      if (resolved) return resolved;
    }

    const parents = await reverseMountParents(sql, current.pageId);
    for (const parent of parents) {
      if (!visited.has(parent.page_id)) {
        queue.push({ pageId: parent.page_id, entryBlockId: parent.block_id });
      }
    }
  }
  return null;
}

async function localSessionDefaults(
  sql: PageReadQuerySql,
  pageId: string,
): Promise<readonly SessionDefaultsRow[]> {
  return await sql<readonly SessionDefaultsRow[]>`
    SELECT id, page_id, position_key, properties
    FROM blocks
    WHERE page_id = ${pageId}
      AND block_type = 'session_defaults'
    ORDER BY position_key ASC, id ASC
  `;
}

async function ancestorSessionDefaults(
  sql: PageReadQuerySql,
  pageId: string,
  entryBlockId: string,
): Promise<readonly SessionDefaultsRow[]> {
  return await sql<readonly SessionDefaultsRow[]>`
    WITH RECURSIVE ancestors AS (
      SELECT id, page_id, parent_id, position_key, block_type, properties,
             0 AS depth, ARRAY[id]::text[] AS path
      FROM blocks
      WHERE id = ${entryBlockId} AND page_id = ${pageId}
      UNION ALL
      SELECT parent.id, parent.page_id, parent.parent_id, parent.position_key,
             parent.block_type, parent.properties, child.depth + 1,
             child.path || parent.id
      FROM blocks parent
      JOIN ancestors child ON child.parent_id = parent.id
      WHERE parent.page_id = ${pageId}
        AND NOT parent.id = ANY(child.path)
    )
    SELECT id, page_id, position_key, properties
    FROM ancestors
    WHERE block_type = 'session_defaults'
    ORDER BY depth ASC, position_key ASC, id ASC
  `;
}

async function reverseMountParents(
  sql: PageReadQuerySql,
  pageId: string,
): Promise<readonly MountParentRow[]> {
  return await sql<readonly MountParentRow[]>`
    SELECT source.page_id, source.id AS block_id, source.position_key
    FROM block_links link
    JOIN blocks source ON source.id = link.source_block_id
    LEFT JOIN blocks target ON target.id = link.target_block_id
    WHERE (link.target_page_id = ${pageId} OR target.page_id = ${pageId})
      AND link.link_kind = 'mount'
      AND source.page_id <> ${pageId}
    ORDER BY source.page_id ASC, source.position_key ASC, source.id ASC
  `;
}

function sessionDefaultsDto(row: SessionDefaultsRow): PageSessionDefaultsDto | null {
  const scope = optionalTrimmedString(row.properties.scope);
  const agentId = optionalTrimmedString(row.properties.agentId);
  const nodeId = optionalTrimmedString(row.properties.nodeId);
  if (!scope || (!agentId && !nodeId)) return null;
  return {
    agentId,
    nodeId,
    sourcePageId: row.page_id,
    sourceBlockId: row.id,
  };
}

function optionalTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}
