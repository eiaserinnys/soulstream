import {
  BoardItemRouteError,
  type BoardItemRecord,
  type BoardItemRouteProvider,
} from "../board/board_item_routes.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";

export function createLiveBoardItemRouteProvider(
  sqlResolver: LiveDbSqlResolver,
  folderProvider: LiveFolderProvider,
): BoardItemRouteProvider {
  return {
    listFolders: folderProvider.listFolders,
    async listBoardItems(query) {
      const sql = await sqlResolver.resolveSql();
      if ("folderId" in query) {
        const rows = await sql`
          SELECT *
          FROM board_item_get_all()
          WHERE folder_id = ${query.folderId}
            AND membership_kind = 'primary'
          ORDER BY y, x, created_at
        `;
        return rows.flatMap(serializeBoardItemRow);
      }
      const rows = await sql`
        SELECT board_items
        FROM board_yjs_catalog_cache
        WHERE container_kind = ${query.container.kind}
          AND container_id = ${query.container.id}
        ORDER BY container_id
      `;
      return rows.flatMap((row) => decodeBoardItems(row.board_items));
    },
    async resolveBoardContainerFolderId(container) {
      if (container.kind === "folder") return container.id;
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT folder_id
        FROM board_yjs_catalog_cache
        WHERE container_kind = 'runbook'
          AND container_id = ${container.id}
        LIMIT 1
      `;
      const folderId = stringValue(rows[0]?.folder_id);
      if (folderId !== null) return folderId;
      throw new BoardItemRouteError(
        "BOARD_CONTAINER_NOT_FOUND",
        "Runbook board container not found",
        404,
      );
    },
    async getCatalogSnapshot() {
      return {
        folders: await folderProvider.listFolders(),
        boardItems: await listAllBoardItems(sqlResolver),
      };
    },
  };
}

async function listAllBoardItems(
  sqlResolver: LiveDbSqlResolver,
): Promise<BoardItemRecord[]> {
  const sql = await sqlResolver.resolveSql();
  const rows = await sql`
    SELECT * FROM board_item_get_all()
  `;
  return rows.flatMap(serializeBoardItemRow);
}

function serializeBoardItemRow(row: Record<string, unknown>): BoardItemRecord[] {
  const id = stringValue(row.id);
  const folderId = stringValue(row.folder_id ?? row.folderId);
  const itemType = stringValue(row.item_type ?? row.itemType);
  const itemId = stringValue(row.item_id ?? row.itemId);
  if (id === null || folderId === null || itemType === null || itemId === null) {
    return [];
  }
  const record: BoardItemRecord = {
    id,
    folderId,
    containerKind: stringValue(row.container_kind ?? row.containerKind) ?? "folder",
    containerId: stringValue(row.container_id ?? row.containerId) ?? folderId,
    membershipKind:
      stringValue(row.membership_kind ?? row.membershipKind) ?? "primary",
    sourceRunbookItemId: stringValue(
      row.source_runbook_item_id ?? row.sourceRunbookItemId,
    ),
    itemType,
    itemId,
    x: numberValue(row.x) ?? 0,
    y: numberValue(row.y) ?? 0,
    metadata: objectValue(row.metadata),
  };
  const createdAt = timestampString(row.created_at ?? row.createdAt);
  if (createdAt !== undefined) record.createdAt = createdAt;
  const updatedAt = timestampString(row.updated_at ?? row.updatedAt);
  if (updatedAt !== undefined) record.updatedAt = updatedAt;
  return [record];
}

function decodeBoardItems(value: unknown): BoardItemRecord[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    try {
      return decodeBoardItems(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item !== null && typeof item === "object"
      ? [item as BoardItemRecord]
      : [],
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function timestampString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : undefined;
}
