import * as Y from "yjs";

import {
  BOARD_ITEMS_MAP,
  MARKDOWN_BODIES_MAP,
  boardYjsFolderScope,
  normalizeLegacyBoardYjsItemValue,
} from "./board_yjs_document.js";
import {
  MarkdownDocumentVersionConflictError,
  normalizeMarkdownVersion,
} from "./markdown_document_version.js";
import type {
  BoardYjsContainerScope,
  BoardYjsItemValue,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
  MovedBoardYjsItem,
} from "./board_yjs_types.js";

export * from "./board_yjs_document.js";
export type * from "./board_yjs_types.js";

type BoardYjsScopeInput = string | BoardYjsContainerScope;

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
  input: { title: string; body: string; x: number; y: number; documentId: string },
): { document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow } {
  const scope = typeof scopeInput === "string" ? boardYjsFolderScope(scopeInput) : scopeInput;
  const title = normalizeMarkdownTitle(input.title);
  const text = getOrCreateMarkdownText(doc, input.documentId);
  text.delete(0, text.length);
  text.insert(0, input.body);
  const boardItem: CatalogBoardItemRow = {
    id: `markdown:${input.documentId}`,
    folderId: scope.folderId,
    containerKind: scope.containerKind,
    containerId: scope.containerId,
    membershipKind: "primary",
    sourceTaskItemId: null,
    itemType: "markdown",
    itemId: input.documentId,
    x: input.x,
    y: input.y,
    metadata: {
      title,
      preview: getMarkdownPreview(input.body),
      version: 1,
    },
  };
  upsertBoardYjsItem(doc, boardItem);
  return {
    document: { id: input.documentId, title, body: input.body, version: 1 },
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
  const stored = boardItems.get(boardItemId);
  if (!stored) return null;
  const current = normalizeLegacyBoardYjsItemValue(stored);
  const metadata = current.metadata && typeof current.metadata === "object" ? current.metadata : {};
  const currentVersion = normalizeMarkdownVersion(metadata.version);
  if (currentVersion !== fields.expectedVersion) {
    throw new MarkdownDocumentVersionConflictError(
      documentId,
      fields.expectedVersion,
      currentVersion,
    );
  }
  const title = fields.title === undefined
    ? (typeof metadata.title === "string" ? metadata.title : "Untitled document")
    : normalizeMarkdownTitle(fields.title);
  const text = getOrCreateMarkdownText(doc, documentId);
  const body = fields.body ?? text.toString();
  if (fields.body !== undefined) {
    text.delete(0, text.length);
    text.insert(0, body);
  }
  boardItems.set(boardItemId, {
    ...current,
    metadata: {
      ...metadata,
      title,
      preview: getMarkdownPreview(body),
      version: currentVersion + 1,
    },
    updated_at: new Date().toISOString(),
  });
  return { id: documentId, title, body, version: currentVersion + 1 };
}

export function deleteMarkdownYjsDocument(doc: Y.Doc, documentId: string): void {
  doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).delete(`markdown:${documentId}`);
  doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP).delete(documentId);
}

export function upsertTaskYjsBoardItem(
  doc: Y.Doc,
  input: {
    folderId: string;
    boardItemId: string;
    taskId: string;
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
    sourceTaskItemId: null,
    itemType: "task",
    itemId: input.taskId,
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
    sourceTaskItemId: null,
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
  const stored = boardItems.get(boardItemId);
  if (!stored) return null;
  const current = normalizeLegacyBoardYjsItemValue(stored);
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
      sourceTaskItemId: value.source_task_item_id ?? null,
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

export function upsertMovedBoardYjsItem(doc: Y.Doc, moved: MovedBoardYjsItem): void {
  doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).set(moved.boardItem.id, moved.value);
  if (moved.value.item_type !== "markdown") return;
  const text = getOrCreateMarkdownText(doc, moved.value.item_id);
  text.delete(0, text.length);
  text.insert(0, moved.markdownBody ?? "");
}

export function deleteMovedBoardYjsItem(doc: Y.Doc, moved: MovedBoardYjsItem): void {
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
    ...(boardItem.sourceTaskItemId !== undefined
      ? { source_task_item_id: boardItem.sourceTaskItemId }
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
