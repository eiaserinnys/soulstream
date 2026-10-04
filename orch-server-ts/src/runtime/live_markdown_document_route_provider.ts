import {
  MarkdownDocumentRouteError,
  type MarkdownDocumentRecord,
  type MarkdownDocumentRouteProvider,
} from "../board/markdown_document_routes.js";
import {
  BoardItemRouteError,
  type BoardItemRouteProvider,
} from "../board/board_item_routes.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";
import { CustomViewProjectionRepository } from "../board-yjs/custom_view_projection_repository.js";

export function createLiveMarkdownDocumentRouteProvider(
  sqlResolver: LiveDbSqlResolver,
  folderProvider: LiveFolderProvider,
): MarkdownDocumentRouteProvider {
  const customViews = new CustomViewProjectionRepository(sqlResolver);
  return {
    listFolders: folderProvider.listFolders,
    async getMarkdownDocument(documentId) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT
          md.id,
          md.title,
          md.body,
          md.version,
          md.created_at,
          md.updated_at,
          bi.folder_id
        FROM markdown_documents md
        LEFT JOIN board_items bi
          ON bi.item_type = 'markdown'
         AND bi.item_id = md.id
         AND bi.membership_kind = 'primary'
        WHERE md.id = ${documentId}
        ORDER BY bi.created_at
        LIMIT 1
      `;
      return rows[0] ? serializeMarkdownDocumentRow(rows[0]) : null;
    },
    async getCustomView(customViewId) {
      const result = await customViews.getCustomView(customViewId);
      if (!result) return null;
      const { customView, boardItem } = result;
      return {
        id: customView.id,
        boardItemId: customView.boardItemId,
        folderId: boardItem.folderId,
        title: customView.title,
        html: customView.html,
        revision: customView.revision,
        archived: customView.archived,
        ...(customView.createdAt === undefined ? {} : { createdAt: customView.createdAt }),
        ...(customView.updatedAt === undefined ? {} : { updatedAt: customView.updatedAt }),
      };
    },
  };
}

function serializeMarkdownDocumentRow(row: Record<string, unknown>): MarkdownDocumentRecord {
  const record: MarkdownDocumentRecord = {
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    version: numberValue(row.version) ?? 1,
  };
  const folderId = stringOrNull(row.folder_id ?? row.folderId);
  if (folderId !== null) record.folderId = folderId;

  const createdAt = timestampString(row.created_at ?? row.createdAt);
  if (createdAt !== undefined) record.createdAt = createdAt;
  const updatedAt = timestampString(row.updated_at ?? row.updatedAt);
  if (updatedAt !== undefined) record.updatedAt = updatedAt;
  return record;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timestampString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : undefined;
}
