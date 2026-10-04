import { executeFolderHostOperation } from "../folders/folder_control_plane_host_route.js";
import { describeFolderOperationError } from "../folders/folder_workspace_routes.js";
import { CustomViewRevisionConflictError, type BoardProjectionHost } from "../board-yjs/board_projection_types.js";
import type { BoardYjsService } from "../board-yjs/board_yjs_service.js";
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

  async function board<T>(
    operation: string,
    invoke: (service: BoardYjsService, projectionHost?: BoardProjectionHost) => Promise<T>,
  ): Promise<T> {
    try {
      const service = options.board.host.service;
      if (!service) throw new Error("Orchestrator Board Yjs service is required");
      return await invoke(service, options.board.host.projectionHost);
    } catch (error) {
      if (operation === "patch-custom-view-record" && error instanceof CustomViewRevisionConflictError) throw error;
      throw new Error(`board Yjs host proxy ${operation} failed: ${error instanceof Error ? error.message : "Board Yjs host operation failed"}`);
    }
  }

  function projection(host: BoardProjectionHost | undefined): BoardProjectionHost {
    if (!host) throw new Error("Orchestrator board projection host is required");
    return host;
  }

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
    listFolderItems: params => board("list-folder-items", (_service, host) =>
      projection(host).listFolderItems(params)),
    getBoardItemsByFolder: folderId => board("get-board-items-by-folder", (_service, host) =>
      projection(host).getBoardItemsByFolder(folderId)),
    getBoardItemById: boardItemId => board("get-board-item", (_service, host) =>
      projection(host).getBoardItemById(boardItemId)),
    getPrimarySessionBoardItem: sessionId => board("get-primary-session-board-item", (_service, host) =>
      projection(host).getPrimarySessionBoardItem(sessionId)),
    getMarkdownDocument: documentId => board("get-markdown-document", (_service, host) =>
      projection(host).getMarkdownDocument(documentId)),
    getMarkdownDocumentBoardItem: documentId => board("get-markdown-document-board-item", (_service, host) =>
      projection(host).getMarkdownDocumentBoardItem(documentId)),
  };

  const mutations: BoardMcpMutationPort = {
    moveSessionToFolder: (sessionId, folderId) => board("move-session-to-folder", service =>
      service.moveSessionToFolder(sessionId, folderId)),
    updateBoardItemPosition: async (folderId, boardItemId, x, y) => {
      await board("update-board-item-position", service =>
        service.updateBoardItemPosition({ folderId }, boardItemId, x, y));
    },
    // The only authorized behavior fix: the old worker sends targetFolderId, but the host expects folderId.
    moveBoardItemToFolder: ({ boardItem, targetFolderId, ...rest }) => {
      const { createdAt, updatedAt, ...item } = boardItem;
      return board("move-board-item-to-folder", service =>
        service.moveBoardItemToContainer({ ...rest, boardItem: item, targetScope: { folderId: targetFolderId } }));
    },
    createMarkdownDocument: input => board("create-markdown-document", service =>
      service.createMarkdownDocument(input)),
    updateMarkdownDocument: (folderId, documentId, fields) => board("update-markdown-document", service =>
      service.updateMarkdownDocument({ folderId }, documentId, fields)),
    deleteMarkdownDocument: async (folderId, documentId) => {
      await board("delete-markdown-document", service =>
        service.deleteMarkdownDocument({ folderId }, documentId));
    },
    upsertSessionBoardItem: input => board("upsert-session-board-item", service =>
      service.upsertSessionBoardItem(input)),
    getCustomView: customViewId => board("get-custom-view", (_service, host) =>
      projection(host).getCustomView(customViewId)),
    listCustomViews: params => board("list-custom-views", (_service, host) =>
      projection(host).listCustomViews(params)),
    createCustomViewRecord: input => board("create-custom-view-record", (_service, host) =>
      projection(host).createCustomViewRecord(input)),
    patchCustomViewRecord: input => board("patch-custom-view-record", (_service, host) =>
      projection(host).patchCustomViewRecord(input)),
    upsertCustomViewBoardItem: input => board("upsert-custom-view-board-item", service =>
      service.upsertCustomViewBoardItem(input)),
    removeBoardItem: async (folderId, boardItemId) => {
      await board("remove-board-item", service =>
        service.removeBoardItem({ folderId }, boardItemId));
    },
  };

  return { store, mutations, folders: {
    renameFolder: (input: Record<string, unknown>) => folder("rename_folder", input),
    setFolderArchived: ({ archived, ...input }: Record<string, unknown>) => folder(archived ? "archive_folder" : "unarchive_folder", input),
  } };
}
