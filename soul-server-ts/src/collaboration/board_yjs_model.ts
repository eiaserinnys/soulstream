import * as Y from "yjs";

import type {
  BoardContainerKind,
  BoardItemType,
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "../db/session_db.js";
import {
  MarkdownDocumentVersionConflictError,
  normalizeMarkdownVersion,
} from "../db/markdown_document_version.js";

export const BOARD_YJS_LEGACY_FOLDER_PREFIX = "board-folder:";
export const BOARD_YJS_CONTAINER_PREFIX = "board:";
export const BOARD_YJS_PREFIX = BOARD_YJS_LEGACY_FOLDER_PREFIX;
export const BOARD_ITEMS_MAP = "boardItems";
export const MARKDOWN_BODIES_MAP = "markdownBodies";

export interface BoardYjsItemValue {
  item_type: BoardItemType;
  item_id: string;
  x: number;
  y: number;
  membership_kind?: "primary" | "reference";
  source_runbook_item_id?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface BoardYjsReplica {
  boardItems: CatalogBoardItemRow[];
  markdownDocuments: MarkdownDocumentRow[];
}

export interface MovedBoardYjsItem {
  boardItem: CatalogBoardItemRow;
  value: BoardYjsItemValue;
  markdownBody?: string;
}

type BoardYjsScopeInput = string | BoardYjsContainerScope;

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
  if (!folderId.trim()) {
    throw new Error("folderId is required");
  }
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
  const markdownById = new Map(params.markdownDocuments.map((markdown) => [markdown.id, markdown]));

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
          ? {
              ...metadata,
              version: normalizeMarkdownVersion(metadata.version ?? markdown.version),
            }
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
  scopeInput: BoardYjsScopeInput,
  doc: Y.Doc,
): BoardYjsReplica {
  const scope = typeof scopeInput === "string" ? boardYjsFolderScope(scopeInput) : scopeInput;
  return readBoardYDocReplicaForScope(scope, doc);
}

export function readBoardYDocReplicaForScope(
  scope: BoardYjsContainerScope,
  doc: Y.Doc,
): BoardYjsReplica {
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
      const title = typeof metadata.title === "string" ? metadata.title : "Untitled document";
      const body = markdownBodies.get(value.item_id)?.toString() ?? "";
      markdownDocumentsById.set(value.item_id, {
        id: value.item_id,
        title,
        body,
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
  if (params.snapshot && params.snapshot.byteLength > 0) {
    Y.applyUpdate(doc, params.snapshot);
  }
  for (const update of params.updates ?? []) {
    if (update.byteLength > 0) {
      Y.applyUpdate(doc, update);
    }
  }
  return {
    replica: readBoardYDocReplicaForScope(scope, doc),
    snapshot: Y.encodeStateAsUpdate(doc),
  };
}

export function applyBoardYjsPosition(
  doc: Y.Doc,
  boardItemId: string,
  position: { x: number; y: number },
): void {
  const boardItems = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const current = boardItems.get(boardItemId);
  if (!current) return;
  boardItems.set(boardItemId, {
    ...current,
    x: position.x,
    y: position.y,
    updated_at: new Date().toISOString(),
  });
}

export function createMarkdownYjsDocument(
  doc: Y.Doc,
  scopeInput: BoardYjsScopeInput,
  input: {
    title: string;
    body: string;
    x: number;
    y: number;
    documentId: string;
  },
): { document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow } {
  const scope = typeof scopeInput === "string" ? boardYjsFolderScope(scopeInput) : scopeInput;
  const title = normalizeMarkdownTitle(input.title);
  const body = input.body;
  const text = getOrCreateMarkdownText(doc, input.documentId);
  text.delete(0, text.length);
  text.insert(0, body);
  const boardItem: CatalogBoardItemRow = {
    id: `markdown:${input.documentId}`,
    folderId: scope.folderId,
    containerKind: scope.containerKind,
    containerId: scope.containerId,
    membershipKind: "primary",
    sourceRunbookItemId: null,
    itemType: "markdown",
    itemId: input.documentId,
    x: input.x,
    y: input.y,
    metadata: {
      title,
      preview: getMarkdownPreview(body),
      version: 1,
    },
  };
  upsertBoardYjsItem(doc, boardItem);
  return {
    document: { id: input.documentId, title, body, version: 1 },
    boardItem,
  };
}

export function updateMarkdownYjsDocument(
  doc: Y.Doc,
  documentId: string,
  fields: { title?: string; body?: string; expectedVersion: number },
): MarkdownDocumentRow | null {
  const boardItems = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const boardItemId = `markdown:${documentId}`;
  const current = boardItems.get(boardItemId);
  if (!current) return null;

  const currentMetadata = current.metadata && typeof current.metadata === "object"
    ? current.metadata
    : {};
  const currentTitle = typeof currentMetadata.title === "string"
    ? currentMetadata.title
    : "Untitled document";
  const currentVersion = normalizeMarkdownVersion(currentMetadata.version);
  if (currentVersion !== fields.expectedVersion) {
    throw new MarkdownDocumentVersionConflictError(
      documentId,
      fields.expectedVersion,
      currentVersion,
    );
  }
  const title = fields.title !== undefined
    ? normalizeMarkdownTitle(fields.title)
    : currentTitle;
  const text = getOrCreateMarkdownText(doc, documentId);
  const body = fields.body !== undefined ? fields.body : text.toString();
  if (fields.body !== undefined) {
    text.delete(0, text.length);
    text.insert(0, body);
  }

  boardItems.set(boardItemId, {
    ...current,
    metadata: {
      ...currentMetadata,
      title,
      preview: getMarkdownPreview(body),
      version: currentVersion + 1,
    },
    updated_at: new Date().toISOString(),
  });

  return {
    id: documentId,
    title,
    body,
    version: currentVersion + 1,
  };
}

export function deleteMarkdownYjsDocument(
  doc: Y.Doc,
  documentId: string,
): void {
  doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).delete(`markdown:${documentId}`);
  doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP).delete(documentId);
}

export function upsertRunbookYjsBoardItem(
  doc: Y.Doc,
  input: {
    folderId: string;
    boardItemId: string;
    runbookId: string;
    title: string;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  },
): CatalogBoardItemRow {
  const boardItem: CatalogBoardItemRow = {
    id: input.boardItemId,
    folderId: input.folderId,
    containerKind: "folder",
    containerId: input.folderId,
    membershipKind: "primary",
    sourceRunbookItemId: null,
    itemType: "runbook",
    itemId: input.runbookId,
    x: input.x,
    y: input.y,
    metadata: { ...(input.metadata ?? {}), title: input.title },
  };
  upsertBoardYjsItem(doc, boardItem);
  return boardItem;
}

export function upsertCustomViewYjsBoardItem(
  doc: Y.Doc,
  scopeInput: BoardYjsScopeInput,
  input: {
    boardItemId: string;
    customViewId: string;
    title: string;
    html: string;
    revision: number;
    x: number;
    y: number;
    metadata?: Record<string, unknown>;
  },
): CatalogBoardItemRow {
  const scope = typeof scopeInput === "string" ? boardYjsFolderScope(scopeInput) : scopeInput;
  const boardItem: CatalogBoardItemRow = {
    id: input.boardItemId,
    folderId: scope.folderId,
    containerKind: scope.containerKind,
    containerId: scope.containerId,
    membershipKind: "primary",
    sourceRunbookItemId: null,
    itemType: "custom_view",
    itemId: input.customViewId,
    x: input.x,
    y: input.y,
    metadata: {
      ...(input.metadata ?? {}),
      title: input.title,
      preview: getHtmlPreview(input.html),
      revision: input.revision,
    },
  };
  upsertBoardYjsItem(doc, boardItem);
  return boardItem;
}

export function deleteBoardYjsItem(doc: Y.Doc, boardItemId: string): void {
  doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).delete(boardItemId);
}

export function readMovableBoardYjsItem(
  doc: Y.Doc,
  boardItemId: string,
  targetScope: BoardYjsContainerScope,
  position?: { x: number; y: number },
): MovedBoardYjsItem | null {
  const boardItems = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const current = boardItems.get(boardItemId);
  if (!current) return null;
  const now = new Date().toISOString();
  const value: BoardYjsItemValue = {
    ...current,
    x: position?.x ?? Number(current.x),
    y: position?.y ?? Number(current.y),
    membership_kind: current.membership_kind ?? "primary",
    updated_at: now,
  };
  const markdownBody = current.item_type === "markdown"
    ? doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP).get(current.item_id)?.toString() ?? ""
    : undefined;
  return {
    boardItem: {
      id: boardItemId,
      folderId: targetScope.folderId,
      containerKind: targetScope.containerKind,
      containerId: targetScope.containerId,
      membershipKind: value.membership_kind ?? "primary",
      sourceRunbookItemId: value.source_runbook_item_id ?? null,
      itemType: value.item_type,
      itemId: value.item_id,
      x: value.x,
      y: value.y,
      metadata: value.metadata ?? {},
      ...(current.created_at ? { createdAt: current.created_at } : {}),
      updatedAt: now,
    },
    value,
    ...(markdownBody !== undefined ? { markdownBody } : {}),
  };
}

export function upsertMovedBoardYjsItem(
  doc: Y.Doc,
  moved: MovedBoardYjsItem,
): void {
  doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).set(moved.boardItem.id, moved.value);
  if (moved.value.item_type !== "markdown") return;
  const text = getOrCreateMarkdownText(doc, moved.value.item_id);
  text.delete(0, text.length);
  text.insert(0, moved.markdownBody ?? "");
}

export function deleteMovedBoardYjsItem(
  doc: Y.Doc,
  moved: MovedBoardYjsItem,
): void {
  deleteBoardYjsItem(doc, moved.boardItem.id);
  if (moved.value.item_type === "markdown") {
    doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP).delete(moved.value.item_id);
  }
}

export function upsertBoardYjsItem(doc: Y.Doc, boardItem: CatalogBoardItemRow): void {
  doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).set(boardItem.id, {
    item_type: boardItem.itemType,
    item_id: boardItem.itemId,
    x: boardItem.x,
    y: boardItem.y,
    ...(boardItem.membershipKind ? { membership_kind: boardItem.membershipKind } : {}),
    ...(boardItem.sourceRunbookItemId !== undefined
      ? { source_runbook_item_id: boardItem.sourceRunbookItemId }
      : {}),
    metadata: boardItem.metadata ?? {},
    ...(boardItem.createdAt ? { created_at: boardItem.createdAt } : {}),
    ...(boardItem.updatedAt ? { updated_at: boardItem.updatedAt } : {}),
  });
}

function getOrCreateMarkdownText(doc: Y.Doc, documentId: string): Y.Text {
  const map = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  let text = map.get(documentId);
  if (!text) {
    text = new Y.Text();
    map.set(documentId, text);
  }
  return text;
}

function normalizeMarkdownTitle(title: string): string {
  return title.trim() || "Untitled document";
}

function getMarkdownPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 180);
}

function getHtmlPreview(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}

function isBoardContainerKind(value: string): value is BoardContainerKind {
  return value === "folder" || value === "runbook";
}

function assertBoardYjsContainer(container: BoardYjsContainerRef): void {
  if (!isBoardContainerKind(container.containerKind)) {
    throw new Error(`unsupported board container kind: ${String(container.containerKind)}`);
  }
  if (!container.containerId.trim()) {
    throw new Error("containerId is required");
  }
}

function scopeFromSnapshotParams(params: {
  folderId: string;
  containerKind?: BoardContainerKind;
  containerId?: string;
}): BoardYjsContainerScope {
  if (!params.folderId.trim()) {
    throw new Error("folderId is required");
  }
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
  const containerKind = item.containerKind ?? "folder";
  const containerId = item.containerId ?? item.folderId;
  return containerKind === scope.containerKind && containerId === scope.containerId;
}
