import { executeFolderHostOperation } from "../folders/folder_control_plane_host_route.js";
import { describeFolderOperationError } from "../folders/folder_workspace_routes.js";
import { dispatchBoardYjsHostOperation, getBoardYjsHostOperationSchema } from "../board-yjs/board_yjs_host_operations.js";
import { CustomViewRevisionConflictError } from "../board-yjs/board_projection_types.js";
import type { McpHostOptions } from "./types.js";
import type { BoardMcpMutationPort, BoardMcpStore, FolderRow } from "./board_catalog_types.js";

// Preserve each old server-to-server JSON/error boundary while executing in this process.
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;
export function createBoardLocalPorts(options: McpHostOptions) {
  async function folder<T>(operation: string, input: Record<string, unknown>): Promise<T> {
    const body = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value]));
    try { return wire(await executeFolderHostOperation(options.folders, operation, wire(body))) as T; }
    catch (error) {
      const failure = describeFolderOperationError(error);
      throw Object.assign(new Error(`folder host ${operation} failed: ${failure.message}`), { statusCode: failure.status });
    }
  }
  async function board<T>(operation: string, input: Record<string, unknown>): Promise<T> {
    const parsed = getBoardYjsHostOperationSchema(operation)!.safeParse(wire(input));
    if (!parsed.success) throw new Error(`board Yjs host proxy ${operation} failed: ${parsed.error.message}`);
    try {
      const service = options.board.host.service;
      if (!service) throw new Error("Orchestrator Board Yjs service is required");
      return wire(await dispatchBoardYjsHostOperation(operation, parsed.data, { ...options.board.host, service })) as T;
    }
    catch (error) {
      if (operation === "patch-custom-view-record" && error instanceof CustomViewRevisionConflictError) {
        // Legacy host puts actualRevision beside message, but its envelope reader only reads details.
        // The worker consequently reports expectedRevision as actual; preserve that error text here.
        throw new CustomViewRevisionConflictError(error.customViewId, error.expectedRevision, error.expectedRevision);
      }
      throw new Error(`board Yjs host proxy ${operation} failed: ${error instanceof Error ? error.message : "Board Yjs host operation failed"}`);
    }
  }
  const store: BoardMcpStore = {
    getAllFolders: () => folder("get_all", {}),
    getFolderById: async folderId => {
      try {
        const snapshot = await folder<{ folder: Record<string, unknown> }>("get_folder", { folderId });
        return Object.fromEntries(Object.entries(snapshot.folder).map(([key, value]) => [
          key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value,
        ])) as unknown as FolderRow;
      } catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return null; throw error; }
    },
    getSessionAssignmentsByIds: sessionIds => folder("get_session_assignments", { sessionIds }),
    getSession: async id => wire(await options.board.getSession(id)),
    listFolderItems: params => board("list-folder-items", { ...params }),
    getBoardItemsByFolder: folderId => board("get-board-items-by-folder", { folderId }),
    getBoardItemById: boardItemId => board("get-board-item", { boardItemId }),
    getPrimarySessionBoardItem: sessionId => board("get-primary-session-board-item", { sessionId }),
    getMarkdownDocument: documentId => board("get-markdown-document", { documentId }),
    getMarkdownDocumentBoardItem: documentId => board("get-markdown-document-board-item", { documentId }),
  };
  const mutations: BoardMcpMutationPort = {
    moveSessionToFolder: (sessionId, folderId) => board("move-session-to-folder", { sessionId, folderId }),
    updateBoardItemPosition: async (folderId, boardItemId, x, y) => { await board("update-board-item-position", { folderId, boardItemId, x, y }); },
    // The only authorized behavior fix: the old worker sends targetFolderId, but the host expects folderId.
    moveBoardItemToFolder: ({ boardItem, targetFolderId, ...rest }) => {
      const { createdAt, updatedAt, ...item } = boardItem;
      return board("move-board-item-to-folder", { boardItem: item, folderId: targetFolderId, ...rest });
    },
    createMarkdownDocument: input => board("create-markdown-document", { ...input }),
    updateMarkdownDocument: (folderId, documentId, fields) => board("update-markdown-document", { folderId, documentId, fields }),
    deleteMarkdownDocument: async (folderId, documentId) => { await board("delete-markdown-document", { folderId, documentId }); },
    upsertSessionBoardItem: input => board("upsert-session-board-item", { ...input }),
    getCustomView: customViewId => board("get-custom-view", { customViewId }),
    listCustomViews: params => board("list-custom-views", { ...params }),
    createCustomViewRecord: input => board("create-custom-view-record", { ...input }),
    patchCustomViewRecord: input => board("patch-custom-view-record", { ...input }),
    upsertCustomViewBoardItem: input => board("upsert-custom-view-board-item", { ...input }),
    removeBoardItem: async (folderId, boardItemId) => { await board("remove-board-item", { folderId, boardItemId }); },
  };
  return { store, mutations, folders: {
    renameFolder: (input: Record<string, unknown>) => folder("rename_folder", input),
    setFolderArchived: ({ archived, ...input }: Record<string, unknown>) => folder(archived ? "archive_folder" : "unarchive_folder", input),
  } };
}
