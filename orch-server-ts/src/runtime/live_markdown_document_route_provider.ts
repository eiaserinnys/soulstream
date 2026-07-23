import {
  MarkdownDocumentRouteError,
  type CustomViewRecord,
  type MarkdownDocumentRecord,
  type MarkdownDocumentRouteProvider,
} from "../board/markdown_document_routes.js";
import {
  BoardItemRouteError,
  type BoardItemRouteProvider,
} from "../board/board_item_routes.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";

export function createLiveMarkdownDocumentRouteProvider(
  sqlResolver: LiveDbSqlResolver,
  folderProvider: LiveFolderProvider,
  boardItemProvider: Pick<BoardItemRouteProvider, "resolveBoardContainerFolderId">,
): MarkdownDocumentRouteProvider {
  return {
    listFolders: folderProvider.listFolders,
    async resolveBoardContainerFolderId(container) {
      if (container.kind === "folder") return container.id;
      try {
        return await boardItemProvider.resolveBoardContainerFolderId(container);
      } catch (error) {
        if (error instanceof BoardItemRouteError) {
          throw new MarkdownDocumentRouteError(
            error.code,
            error.message,
            error.statusCode,
          );
        }
        throw new MarkdownDocumentRouteError(
          "BOARD_CONTAINER_NOT_FOUND",
          error instanceof Error ? error.message : String(error),
          404,
        );
      }
    },
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
          bi.folder_id,
          bi.container_kind,
          bi.container_id
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
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT
          cv.id,
          cv.board_item_id,
          bi.folder_id,
          cv.title,
          cv.html,
          cv.revision,
          cv.archived,
          cv.created_session_id,
          cv.created_event_id,
          cv.updated_session_id,
          cv.updated_event_id,
          cv.created_at,
          cv.updated_at
        FROM board_custom_views cv
        JOIN board_items bi ON bi.id = cv.board_item_id
        WHERE cv.id = ${customViewId}
        LIMIT 1
      `;
      return rows[0] ? serializeCustomViewRow(rows[0]) : null;
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
  const containerKind = stringOrNull(row.container_kind ?? row.containerKind);
  if (containerKind === "folder" || containerKind === "task") {
    record.containerKind = containerKind;
  }
  const containerId = stringOrNull(row.container_id ?? row.containerId);
  if (containerId !== null) record.containerId = containerId;
  const createdAt = timestampString(row.created_at ?? row.createdAt);
  if (createdAt !== undefined) record.createdAt = createdAt;
  const updatedAt = timestampString(row.updated_at ?? row.updatedAt);
  if (updatedAt !== undefined) record.updatedAt = updatedAt;
  return record;
}

function serializeCustomViewRow(row: Record<string, unknown>): CustomViewRecord {
  const record: CustomViewRecord = {
    id: String(row.id ?? ""),
    boardItemId: String(row.board_item_id ?? row.boardItemId ?? ""),
    folderId: String(row.folder_id ?? row.folderId ?? ""),
    title: stringOrNull(row.title),
    html: String(row.html ?? ""),
    revision: numberValue(row.revision) ?? 1,
    archived: booleanValue(row.archived) ?? false,
  };
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

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "t") return true;
  if (value === "false" || value === "f") return false;
  return undefined;
}

function timestampString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : undefined;
}
