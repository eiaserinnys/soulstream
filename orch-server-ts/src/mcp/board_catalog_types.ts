import type { FolderControlPlaneService } from "../folders/folder_control_plane_service.js";
import type { BoardProjectionHost } from "../board-yjs/board_projection_types.js";
import type { CatalogBoardYjsPort } from "./board_catalog_items.js";
import type { CustomViewBoardYjsPort } from "./board_custom_view_service.js";

export type FolderRow = Awaited<ReturnType<FolderControlPlaneService["getAllFolders"]>>[number];
export interface BoardMcpStore extends Pick<BoardProjectionHost,
  "listFolderItems" | "getBoardItemById" | "getBoardItemsByFolder" | "getPrimarySessionBoardItem" |
  "getMarkdownDocumentBoardItem" | "getMarkdownDocument"> {
  getAllFolders(): Promise<FolderRow[]>;
  getFolderById(folderId: string): Promise<FolderRow | null>;
  getSessionAssignmentsByIds(ids: readonly string[]): ReturnType<FolderControlPlaneService["getSessionAssignmentsByIds"]>;
  getSession(id: string): Promise<{ folder_id: string | null } | null>;
}
export interface BoardMcpFolderMutations {
  renameFolder(input: { actorKind: "system"; actorSessionId: null; folderId: string; expectedVersion: number;
    name?: string; parentFolderId?: string | null; settings?: Record<string, unknown>; idempotencyKey: string }): Promise<unknown>;
  setFolderArchived(input: { actorKind: "system"; actorSessionId: null; folderId: string; expectedVersion: number;
    archived: boolean; idempotencyKey: string }): Promise<unknown>;
}
export type BoardMcpMutationPort = CatalogBoardYjsPort & CustomViewBoardYjsPort;
