import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { BoardProjectionReadRepository } from "./board_projection_read_repository.js";
import { CustomViewProjectionRepository } from "./custom_view_projection_repository.js";
import type { BoardProjectionHost } from "./board_projection_types.js";
import type { BoardYjsRepository } from "./board_yjs_repository.js";

export function createBoardProjectionHost(
  sqlResolver: LiveDbSqlResolver,
  boardYjsRepository: BoardYjsRepository,
): BoardProjectionHost {
  const reads = new BoardProjectionReadRepository(sqlResolver);
  const customViews = new CustomViewProjectionRepository(sqlResolver);
  return {
    getBoardItems: () => reads.getBoardItems(),
    getBoardItemsByFolder: (folderId) => reads.getBoardItemsByFolder(folderId),
    getBoardItemById: (boardItemId) => reads.getBoardItemById(boardItemId),
    getPrimarySessionBoardItem: (sessionId) =>
      reads.getPrimarySessionBoardItem(sessionId),
    getMarkdownDocumentBoardItem: (documentId) =>
      reads.getMarkdownDocumentBoardItem(documentId),
    getBoardItemIdsForSession: (sessionId) =>
      reads.getBoardItemIdsForSession(sessionId),
    listFolderItems: (params) => reads.listFolderItems(params),
    resolveBoardYjsFolderScope: (container) =>
      boardYjsRepository.resolveBoardYjsFolderScope(container),
    getMarkdownDocument: (documentId) => reads.getMarkdownDocument(documentId),
    getCustomView: (customViewId) => customViews.getCustomView(customViewId),
    listCustomViews: (params) => customViews.listCustomViews(params),
    createCustomViewRecord: (input) => customViews.createCustomViewRecord(input),
    patchCustomViewRecord: (input) => customViews.patchCustomViewRecord(input),
  };
}
