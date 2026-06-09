/**
 * @seosoyoung/soul-ui - Lib Barrel
 */

// === Core Utilities ===
export { cn } from "./cn";
export { BATCH_SIZE, BATCH_FLUSH_MS } from "./event-batch";
export { flattenTree } from "./flatten-tree";
export type { ChatMessage } from "./flatten-tree";
export { submitInputResponse } from "./input-request-actions";
export { formatTime } from "./input-request-utils";

// === Folder / Session Operations ===
export { createFolderOperations } from "./folder-operations";
export type { FolderApiConfig, FolderOperations } from "./folder-operations";
export {
  buildFolderTreeOptions,
  compareFoldersByName,
  getFolderNameSortKey,
} from "./folder-tree-options";
export type { FolderTreeOption } from "./folder-tree-options";
export { createBoardWorkspaceOperations } from "./board-workspace-operations";
export type {
  BoardWorkspaceApiConfig,
  BoardWorkspaceOperations,
  BoardAssetCommitResponse,
  CreateMarkdownDocumentRequest,
  CreateMarkdownDocumentResponse,
  UploadBoardAssetInput,
} from "./board-workspace-operations";
export { createMoveSessionsOperations } from "./move-sessions";
export type { MoveSessionsApiConfig, MoveSessionsOperations } from "./move-sessions";
export { shouldLoadMoreAfterSessionMove } from "./session-move-load-more";
export type { SessionMoveLoadMoreState } from "./session-move-load-more";

// === Rename Session ===
export { renameSessionOptimistic, createRenameSessionOperation } from "./rename-session";
export type { RenameSessionApiConfig, RenameSessionOperations } from "./rename-session";

// === Viewport API (Phase 3) ===
export { encodeCursor, decodeCursor } from "./cursor-codec";
