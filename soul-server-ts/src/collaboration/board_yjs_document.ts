import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
} from "../db/session_db.js";
import { normalizeBoardContainerKind } from "./board_container_kind_compat.js";

export const BOARD_YJS_LEGACY_FOLDER_PREFIX = "board-folder:";
export const BOARD_YJS_CONTAINER_PREFIX = "board:";
export const BOARD_YJS_PREFIX = BOARD_YJS_LEGACY_FOLDER_PREFIX;
export const BOARD_ITEMS_MAP = "boardItems";
export const MARKDOWN_BODIES_MAP = "markdownBodies";

export function getBoardYjsDocumentName(folderId: string): string {
  return getBoardYjsContainerDocumentName(boardYjsFolderScope(folderId));
}

export function getBoardYjsContainerDocumentName(
  container: BoardYjsContainerRef,
): string {
  assertBoardYjsContainer(container);
  if (container.containerKind === "folder") {
    return `${BOARD_YJS_LEGACY_FOLDER_PREFIX}${container.containerId}`;
  }
  return `${BOARD_YJS_CONTAINER_PREFIX}${container.containerKind}:${container.containerId}`;
}

export function getFormalBoardYjsDocumentName(
  container: BoardYjsContainerRef,
): string {
  assertBoardYjsContainer(container);
  return `${BOARD_YJS_CONTAINER_PREFIX}${container.containerKind}:${container.containerId}`;
}

export function normalizeBoardYjsDocumentName(documentName: string): string | null {
  const container = parseBoardYjsDocumentName(documentName);
  return container ? getBoardYjsContainerDocumentName(container) : null;
}

export function parseBoardYjsDocumentName(
  documentName: string,
): BoardYjsContainerRef | null {
  if (documentName.startsWith(BOARD_YJS_LEGACY_FOLDER_PREFIX)) {
    const folderId = documentName.slice(BOARD_YJS_LEGACY_FOLDER_PREFIX.length);
    return folderId.length > 0
      ? { containerKind: "folder", containerId: folderId }
      : null;
  }
  if (!documentName.startsWith(BOARD_YJS_CONTAINER_PREFIX)) return null;
  const rest = documentName.slice(BOARD_YJS_CONTAINER_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const containerKind = normalizeBoardContainerKind(rest.slice(0, separator));
  const containerId = rest.slice(separator + 1);
  if (!containerKind || containerId.length === 0) return null;
  return { containerKind, containerId };
}

export function boardYjsFolderScope(folderId: string): BoardYjsContainerScope {
  if (!folderId.trim()) throw new Error("folderId is required");
  return { folderId, containerKind: "folder", containerId: folderId };
}

export function getFolderIdFromBoardYjsDocumentName(
  documentName: string,
): string | null {
  const container = parseBoardYjsDocumentName(documentName);
  return container?.containerKind === "folder" ? container.containerId : null;
}

function assertBoardYjsContainer(container: BoardYjsContainerRef): void {
  if (!normalizeBoardContainerKind(container.containerKind)) {
    throw new Error(
      `unsupported board container kind: ${String(container.containerKind)}`,
    );
  }
  if (!container.containerId.trim()) throw new Error("containerId is required");
}
