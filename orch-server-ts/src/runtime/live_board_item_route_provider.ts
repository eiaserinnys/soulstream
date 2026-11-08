import type { BoardItemRouteProvider } from "../board/board_item_routes.js";
import { FolderContentRepository } from "../board/folder_content_repository.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";

export function createLiveBoardItemRouteProvider(
  sqlResolver: LiveDbSqlResolver,
  folderProvider: LiveFolderProvider,
): BoardItemRouteProvider {
  const boardItems = new FolderContentRepository(sqlResolver);
  return {
    listFolders: folderProvider.listFolders,
    async listBoardItems(query) {
      if ("folderId" in query) return (await boardItems.getBoardItemsByFolder(query.folderId)).map(item => ({ ...item }));
      const item = await boardItems.getPrimarySessionBoardItem(query.sessionId);
      return item ? [{ ...item }] : [];
    },
    async getBoardItemById(id) {
      const item = await boardItems.getBoardItemById(id);
      return item ? { ...item } : null;
    },
    async getCatalogSnapshot() {
      return { folders: await folderProvider.listFolders(), boardItems: (await boardItems.getBoardItems()).map(item => ({ ...item })) };
    },
  };
}
