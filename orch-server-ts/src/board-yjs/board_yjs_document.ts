import * as Y from "yjs";

import { normalizeBoardContainerKind } from "./board_container_kind_compat.js";
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
  const rawContainerKind = rest.slice(0, separator);
  const containerId = rest.slice(separator + 1);
  const containerKind = normalizeBoardContainerKind(rawContainerKind);
  if (!containerKind || containerId.length === 0) return null;
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
        ...(item.sourceTaskItemId !== undefined
          ? { source_task_item_id: item.sourceTaskItemId }
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
    const normalizedValue = normalizeLegacyBoardYjsItemValue(value);
    const metadata = normalizedValue.metadata && typeof normalizedValue.metadata === "object"
      ? normalizedValue.metadata
      : {};
    rows.push({
      id,
      folderId: scope.folderId,
      containerKind: scope.containerKind,
      containerId: scope.containerId,
      membershipKind: normalizedValue.membership_kind ?? "primary",
      sourceTaskItemId: normalizedValue.source_task_item_id ?? null,
      itemType: normalizedValue.item_type,
      itemId: normalizedValue.item_id,
      x: Number(normalizedValue.x),
      y: Number(normalizedValue.y),
      metadata,
      ...(normalizedValue.created_at ? { createdAt: normalizedValue.created_at } : {}),
      ...(normalizedValue.updated_at ? { updatedAt: normalizedValue.updated_at } : {}),
    });
    if (normalizedValue.item_type === "markdown") {
      markdownDocumentsById.set(normalizedValue.item_id, {
        id: normalizedValue.item_id,
        title: typeof metadata.title === "string" ? metadata.title : "Untitled document",
        body: markdownBodies.get(normalizedValue.item_id)?.toString() ?? "",
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
  return value === "folder" || value === "task";
}

export function normalizeLegacyBoardYjsItemValue(
  value: BoardYjsItemValue,
): BoardYjsItemValue {
  const legacy = value as Omit<BoardYjsItemValue, "item_type"> & {
    item_type: BoardYjsItemValue["item_type"] | "runbook";
    source_runbook_item_id?: string | null;
  };
  const { source_runbook_item_id: legacySourceItemId, ...canonical } = legacy;
  return {
    ...canonical,
    item_type: legacy.item_type === "runbook" ? "task" : legacy.item_type,
    ...(canonical.source_task_item_id === undefined && legacySourceItemId !== undefined
      ? { source_task_item_id: legacySourceItemId }
      : {}),
  };
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
