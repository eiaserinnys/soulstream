import * as Y from "yjs";

import { normalizeMarkdownVersion } from "./markdown_document_version.js";
import type {
  BoardContainerKind,
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  BoardYjsItemValue,
  BoardYjsReplica,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "./board_yjs_types.js";

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

export function parseBoardYjsDocumentName(documentName: string): BoardYjsContainerRef | null {
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
  const containerKind = rest.slice(0, separator);
  const containerId = rest.slice(separator + 1);
  if (!isBoardContainerKind(containerKind) || containerId.length === 0) return null;
  return { containerKind, containerId };
}

export function boardYjsFolderScope(folderId: string): BoardYjsContainerScope {
  if (!folderId.trim()) throw new Error("folderId is required");
  return { folderId, containerKind: "folder", containerId: folderId };
}

export function getFolderIdFromBoardYjsDocumentName(documentName: string): string | null {
  const container = parseBoardYjsDocumentName(documentName);
  return container?.containerKind === "folder" ? container.containerId : null;
}

export function createBoardYDocSnapshot(params: {
  folderId: string;
  containerKind?: BoardContainerKind;
  containerId?: string;
  boardItems: readonly CatalogBoardItemRow[];
  markdownDocuments: readonly MarkdownDocumentRow[];
}): Uint8Array {
  const scope = scopeFromSnapshotParams(params);
  const doc = new Y.Doc();
  const boardItems = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const markdownBodies = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  const markdownById = new Map(params.markdownDocuments.map((item) => [item.id, item]));

  doc.transact(() => {
    for (const item of params.boardItems) {
      if (!boardItemBelongsToScope(item, scope)) continue;
      const metadata = item.metadata ?? {};
      const markdown = item.itemType === "markdown" ? markdownById.get(item.itemId) : undefined;
      boardItems.set(item.id, {
        item_type: item.itemType,
        item_id: item.itemId,
        x: item.x,
        y: item.y,
        ...(item.membershipKind ? { membership_kind: item.membershipKind } : {}),
        ...(item.sourceRunbookItemId !== undefined
          ? { source_runbook_item_id: item.sourceRunbookItemId }
          : {}),
        metadata: markdown
          ? { ...metadata, version: normalizeMarkdownVersion(metadata.version ?? markdown.version) }
          : metadata,
        ...(item.createdAt ? { created_at: item.createdAt } : {}),
        ...(item.updatedAt ? { updated_at: item.updatedAt } : {}),
      });
    }
    for (const markdown of params.markdownDocuments) {
      const text = new Y.Text();
      text.insert(0, markdown.body);
      markdownBodies.set(markdown.id, text);
    }
  });
  return Y.encodeStateAsUpdate(doc);
}

export function readBoardYDocReplica(
  scopeInput: string | BoardYjsContainerScope,
  doc: Y.Doc,
): BoardYjsReplica {
  const scope = typeof scopeInput === "string" ? boardYjsFolderScope(scopeInput) : scopeInput;
  const boardItems = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const markdownBodies = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  const markdownDocumentsById = new Map<string, MarkdownDocumentRow>();
  const rows: CatalogBoardItemRow[] = [];

  for (const [id, value] of boardItems.entries()) {
    const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata : {};
    rows.push({
      id,
      folderId: scope.folderId,
      containerKind: scope.containerKind,
      containerId: scope.containerId,
      membershipKind: value.membership_kind ?? "primary",
      sourceRunbookItemId: value.source_runbook_item_id ?? null,
      itemType: value.item_type,
      itemId: value.item_id,
      x: Number(value.x),
      y: Number(value.y),
      metadata,
      ...(value.created_at ? { createdAt: value.created_at } : {}),
      ...(value.updated_at ? { updatedAt: value.updated_at } : {}),
    });
    if (value.item_type === "markdown") {
      markdownDocumentsById.set(value.item_id, {
        id: value.item_id,
        title: typeof metadata.title === "string" ? metadata.title : "Untitled document",
        body: markdownBodies.get(value.item_id)?.toString() ?? "",
        version: normalizeMarkdownVersion(metadata.version),
      });
    }
  }
  return {
    boardItems: rows.sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id)),
    markdownDocuments: Array.from(markdownDocumentsById.values()),
  };
}

export function readBoardYDocSnapshot(params: {
  folderId: string;
  containerKind?: BoardContainerKind;
  containerId?: string;
  snapshot?: Uint8Array | null;
  updates?: readonly Uint8Array[];
}): { replica: BoardYjsReplica; snapshot: Uint8Array } {
  const scope = scopeFromSnapshotParams(params);
  const doc = new Y.Doc();
  if (params.snapshot && params.snapshot.byteLength > 0) Y.applyUpdate(doc, params.snapshot);
  for (const update of params.updates ?? []) {
    if (update.byteLength > 0) Y.applyUpdate(doc, update);
  }
  return { replica: readBoardYDocReplica(scope, doc), snapshot: Y.encodeStateAsUpdate(doc) };
}

function isBoardContainerKind(value: string): value is BoardContainerKind {
  return value === "folder" || value === "runbook";
}

function assertBoardYjsContainer(container: BoardYjsContainerRef): void {
  if (!isBoardContainerKind(container.containerKind)) {
    throw new Error(`unsupported board container kind: ${String(container.containerKind)}`);
  }
  if (!container.containerId.trim()) throw new Error("containerId is required");
}

function scopeFromSnapshotParams(params: {
  folderId: string;
  containerKind?: BoardContainerKind;
  containerId?: string;
}): BoardYjsContainerScope {
  if (!params.folderId.trim()) throw new Error("folderId is required");
  return {
    folderId: params.folderId,
    containerKind: params.containerKind ?? "folder",
    containerId: params.containerId ?? params.folderId,
  };
}

function boardItemBelongsToScope(
  item: CatalogBoardItemRow,
  scope: BoardYjsContainerScope,
): boolean {
  return (item.containerKind ?? "folder") === scope.containerKind &&
    (item.containerId ?? item.folderId) === scope.containerId;
}
