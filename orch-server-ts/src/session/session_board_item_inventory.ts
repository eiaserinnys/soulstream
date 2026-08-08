import type { BoardItemDbRow } from "../board-yjs/board_projection_serialization.js";
import { toCatalogBoardItemRow } from "../board-yjs/board_projection_serialization.js";
import type { BoardYjsQuerySql } from "../board-yjs/board_yjs_sql.js";
import type { CatalogBoardItemRow } from "../board-yjs/board_yjs_types.js";

interface BoardYjsCatalogCacheDbRow extends Record<string, unknown> {
  folder_id: string;
  container_kind: "folder" | "task";
  container_id: string;
  board_items: unknown;
}

/**
 * Canonical treatment inventory for a session's board memberships.
 *
 * Projection-only lookup misses cache-only residues, while cache-only lookup
 * misses currently projected rows. Session deletion and movement must share
 * this exact union and exact post-filter.
 */
export async function listSessionBoardItems(
  sql: BoardYjsQuerySql,
  sessionId: string,
): Promise<CatalogBoardItemRow[]> {
  const projectionRows = await sql<readonly BoardItemDbRow[]>`
    SELECT *
    FROM board_items
    WHERE item_type = 'session' AND item_id = ${sessionId}
    ORDER BY container_kind, container_id, id
  `;
  const cacheRows = await sql<readonly BoardYjsCatalogCacheDbRow[]>`
    SELECT folder_id, container_kind, container_id, board_items
    FROM board_yjs_catalog_cache
    WHERE board_items::text LIKE ${`%${sessionId}%`}
    ORDER BY container_kind, container_id
  `;
  const boardItems = new Map<string, CatalogBoardItemRow>();
  for (const row of projectionRows) {
    const boardItem = toCatalogBoardItemRow(row);
    boardItems.set(boardItemKey(boardItem), boardItem);
  }
  for (const cacheRow of cacheRows) {
    for (const boardItem of cachedSessionBoardItems(cacheRow, sessionId)) {
      boardItems.set(boardItemKey(boardItem), boardItem);
    }
  }
  return [...boardItems.values()].sort((left, right) =>
    boardItemKey(left).localeCompare(boardItemKey(right))
  );
}

function cachedSessionBoardItems(
  cacheRow: BoardYjsCatalogCacheDbRow,
  sessionId: string,
): CatalogBoardItemRow[] {
  return decodeCachedBoardItems(cacheRow.board_items).flatMap((value) => {
    const itemType = stringValue(value.itemType ?? value.item_type);
    const itemId = stringValue(value.itemId ?? value.item_id);
    const id = stringValue(value.id);
    if (itemType !== "session" || itemId !== sessionId || id === null) return [];
    const membershipKind = stringValue(value.membershipKind ?? value.membership_kind);
    return [{
      id,
      folderId: cacheRow.folder_id,
      containerKind: cacheRow.container_kind,
      containerId: cacheRow.container_id,
      membershipKind: membershipKind === "reference" ? "reference" : "primary",
      sourceTaskItemId: stringValue(value.sourceTaskItemId ?? value.source_task_item_id),
      itemType: "session" as const,
      itemId: sessionId,
      x: numberValue(value.x),
      y: numberValue(value.y),
      metadata: recordValue(value.metadata),
    }];
  });
}

function decodeCachedBoardItems(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      return decodeCachedBoardItems(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? [item as Record<string, unknown>]
      : []
  );
}

function boardItemKey(boardItem: CatalogBoardItemRow): string {
  return `${boardItem.containerKind ?? "folder"}:${boardItem.containerId ?? boardItem.folderId}:${boardItem.id}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return recordValue(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
