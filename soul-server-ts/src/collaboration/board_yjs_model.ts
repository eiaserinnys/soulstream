import * as Y from "yjs";

import type {
  BoardItemType,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "../db/session_db.js";
import {
  MarkdownDocumentVersionConflictError,
  normalizeMarkdownVersion,
} from "../db/markdown_document_version.js";

export const BOARD_YJS_PREFIX = "board-folder:";
export const BOARD_ITEMS_MAP = "boardItems";
export const MARKDOWN_BODIES_MAP = "markdownBodies";

export interface BoardYjsItemValue {
  item_type: BoardItemType;
  item_id: string;
  x: number;
  y: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface BoardYjsReplica {
  boardItems: CatalogBoardItemRow[];
  markdownDocuments: MarkdownDocumentRow[];
}

export function getBoardYjsDocumentName(folderId: string): string {
  if (!folderId.trim()) {
    throw new Error("folderId is required");
  }
  return `${BOARD_YJS_PREFIX}${folderId}`;
}

export function getFolderIdFromBoardYjsDocumentName(documentName: string): string | null {
  if (!documentName.startsWith(BOARD_YJS_PREFIX)) return null;
  const folderId = documentName.slice(BOARD_YJS_PREFIX.length);
  return folderId.length > 0 ? folderId : null;
}

export function createBoardYDocSnapshot(params: {
  folderId: string;
  boardItems: readonly CatalogBoardItemRow[];
  markdownDocuments: readonly MarkdownDocumentRow[];
}): Uint8Array {
  const doc = new Y.Doc();
  const boardItems = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const markdownBodies = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  const markdownById = new Map(params.markdownDocuments.map((markdown) => [markdown.id, markdown]));

  doc.transact(() => {
    for (const item of params.boardItems) {
      if (item.folderId !== params.folderId) continue;
      const metadata = item.metadata ?? {};
      const markdown = item.itemType === "markdown" ? markdownById.get(item.itemId) : undefined;
      boardItems.set(item.id, {
        item_type: item.itemType,
        item_id: item.itemId,
        x: item.x,
        y: item.y,
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

export function readBoardYDocReplica(folderId: string, doc: Y.Doc): BoardYjsReplica {
  const boardItems = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const markdownBodies = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  const markdownDocumentsById = new Map<string, MarkdownDocumentRow>();

  const rows: CatalogBoardItemRow[] = [];
  for (const [id, value] of boardItems.entries()) {
    const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata : {};
    rows.push({
      id,
      folderId,
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
  snapshot?: Uint8Array | null;
  updates?: readonly Uint8Array[];
}): { replica: BoardYjsReplica; snapshot: Uint8Array } {
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
    replica: readBoardYDocReplica(params.folderId, doc),
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
  folderId: string,
  input: {
    title: string;
    body: string;
    x: number;
    y: number;
    documentId: string;
  },
): { document: MarkdownDocumentRow; boardItem: CatalogBoardItemRow } {
  const title = normalizeMarkdownTitle(input.title);
  const body = input.body;
  const text = getOrCreateMarkdownText(doc, input.documentId);
  text.delete(0, text.length);
  text.insert(0, body);
  const boardItem: CatalogBoardItemRow = {
    id: `markdown:${input.documentId}`,
    folderId,
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

function upsertBoardYjsItem(doc: Y.Doc, boardItem: CatalogBoardItemRow): void {
  doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).set(boardItem.id, {
    item_type: boardItem.itemType,
    item_id: boardItem.itemId,
    x: boardItem.x,
    y: boardItem.y,
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
