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
import { CustomViewProjectionRepository } from "../board/custom_view_repository.js";
import { FolderContentRepository } from "../board/folder_content_repository.js";

export function createLiveMarkdownDocumentRouteProvider(
  sqlResolver: LiveDbSqlResolver,
  folderProvider: LiveFolderProvider,
): MarkdownDocumentRouteProvider {
  const customViews = new CustomViewProjectionRepository(sqlResolver);
  const documents = new FolderContentRepository(sqlResolver);
  return {
    listFolders: folderProvider.listFolders,
    async listMarkdownDocuments(input) {
      const result = await documents.listMarkdownDocuments(input);
      return { documents: result.documents.map(document => ({ ...document })), nextCursor: result.nextCursor };
    },
    async getMarkdownDocument(documentId) {
      const document = await documents.getMarkdownDocument(documentId);
      return document ? { ...document } : null;
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
