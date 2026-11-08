import { executeFolderHostOperation } from "../folders/folder_control_plane_host_route.js";
import { describeFolderOperationError } from "../folders/folder_workspace_routes.js";
import type { McpHostOptions } from "./types.js";
import type { BoardMcpMutationPort, BoardMcpStore, FolderRow } from "./board_catalog_types.js";

// The session adapter and folder mutation boundary still cross JSON contracts.
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;

export function createBoardLocalPorts(options: McpHostOptions) {
  async function folder<T>(operation: string, input: Record<string, unknown>): Promise<T> {
    const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));
    try {
      return wire(await executeFolderHostOperation(options.folders, operation, wire(body))) as T;
    } catch (error) {
      const failure = describeFolderOperationError(error);
      throw Object.assign(new Error(`folder host ${operation} failed: ${failure.message}`), { statusCode: failure.status });
    }
  }

  async function folderRead<T>(operation: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      const failure = describeFolderOperationError(error);
      throw Object.assign(new Error(`folder host ${operation} failed: ${failure.message}`), { statusCode: failure.status });
    }
  }

  const host = options.board.host;

  const store: BoardMcpStore = {
    getAllFolders: () => folderRead("get_all", async () =>
      await (await options.folders.serviceProvider()).getAllFolders()),
    getFolderById: async folderId => {
      try {
        return await folderRead("get_folder", async () =>
          await (await options.folders.serviceProvider()).getFolderById(folderId));
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) return null;
        throw error;
      }
    },
    getSessionAssignmentsByIds: sessionIds => folderRead("get_session_assignments", async () =>
      await (await options.folders.serviceProvider()).getSessionAssignmentsByIds(sessionIds)),
    getSession: async id => wire(await options.board.getSession(id)),
    listFolderItems: params => host.reads.listFolderItems(params),
    getBoardItemsByFolder: folderId => host.reads.getBoardItemsByFolder(folderId),
    getBoardItemById: boardItemId => host.reads.getBoardItemById(boardItemId),
    getPrimarySessionBoardItem: sessionId => host.reads.getPrimarySessionBoardItem(sessionId),
    getMarkdownDocument: documentId => host.reads.getMarkdownDocument(documentId),
    getMarkdownDocumentBoardItem: documentId => host.reads.getMarkdownDocumentBoardItem(documentId),
  };

  const mutations: BoardMcpMutationPort = {
    moveSessionsToFolder: (sessionIds, folderId) => host.sessions.moveSessionsToFolder(sessionIds, folderId),
    createMarkdownDocument: input => host.documents.create(input),
    updateMarkdownDocument: (documentId, fields) => host.documents.update(documentId, fields),
    deleteMarkdownDocument: documentId => host.documents.delete(documentId),
    getCustomView: id => host.customViews.getCustomView(id),
    listCustomViews: params => host.customViews.listCustomViews(params),
    createCustomViewRecord: input => host.customViews.createCustomViewRecord(input),
    patchCustomViewRecord: input => host.customViews.patchCustomViewRecord(input),
    upsertCustomViewBoardItem: input => host.upsertCustomViewBoardItem(input),
    removeBoardItem: (folderId, boardItemId) => host.removeBoardItem(folderId, boardItemId),
  };

  return { store, mutations, folders: {
    renameFolder: (input: Record<string, unknown>) => folder("rename_folder", input),
    setFolderArchived: ({ archived, ...input }: Record<string, unknown>) => folder(archived ? "archive_folder" : "unarchive_folder", input),
  } };
}
