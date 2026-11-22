import type { MarkdownDocumentRouteProvider } from "../board/markdown_document_routes.js";
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
