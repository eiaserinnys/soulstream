import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { BoardProjectionReadRepository } from "./board_projection_read_repository.js";
import { ChecklistProjectionRepository } from "./checklist_projection_repository.js";
import { CustomViewProjectionRepository } from "./custom_view_projection_repository.js";
import type { BoardProjectionHost } from "./board_projection_types.js";
import type { BoardYjsRepository } from "./board_yjs_repository.js";

export function createBoardProjectionHost(
  sqlResolver: LiveDbSqlResolver,
  boardYjsRepository: BoardYjsRepository,
): BoardProjectionHost {
  const reads = new BoardProjectionReadRepository(sqlResolver);
  const customViews = new CustomViewProjectionRepository(sqlResolver);
  const checklist = new ChecklistProjectionRepository(sqlResolver);
  return {
    getBoardItems: () => reads.getBoardItems(),
    getBoardItemById: (boardItemId) => reads.getBoardItemById(boardItemId),
    getPrimarySessionBoardItem: (sessionId) =>
      reads.getPrimarySessionBoardItem(sessionId),
    getMarkdownDocumentBoardItem: (documentId) =>
      reads.getMarkdownDocumentBoardItem(documentId),
    getBoardItemIdsForSession: (sessionId) =>
      reads.getBoardItemIdsForSession(sessionId),
    listContainerItems: (params) => reads.listContainerItems(params),
    resolveBoardYjsContainerScope: (container) =>
      boardYjsRepository.resolveBoardYjsContainerScope(container),
    getMarkdownDocument: (documentId) => reads.getMarkdownDocument(documentId),
    getCustomView: (customViewId) => customViews.getCustomView(customViewId),
    listCustomViews: (params) => customViews.listCustomViews(params),
    createCustomViewRecord: (input) => customViews.createCustomViewRecord(input),
    patchCustomViewRecord: (input) => customViews.patchCustomViewRecord(input),
    claimChecklistTaskProjections: (nodeId, limit, leaseMs) =>
      checklist.claimDue(nodeId, limit, leaseMs),
    markChecklistTaskProjectionSuccess: (row, nodeId) =>
      checklist.markSuccess(row, nodeId),
    markChecklistTaskProjectionFailure: (row, nodeId, error) =>
      checklist.markFailure(row, nodeId, error),
    markChecklistTaskProjectionDeadLetter: (row, nodeId, error) =>
      checklist.markDeadLetter(row, nodeId, error),
  };
}
