import * as Y from "yjs";

import type {
  BoardContainerRef,
  CatalogBoardItem,
  CatalogState,
  MarkdownDocument,
} from "../shared/types";

export const BOARD_ITEMS_MAP = "boardItems";
export const MARKDOWN_BODIES_MAP = "markdownBodies";

export interface BoardYjsItemValue {
  item_type: CatalogBoardItem["itemType"];
  item_id: string;
  x: number;
  y: number;
  membership_kind?: CatalogBoardItem["membershipKind"];
  source_task_item_id?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

type BoardContainerInput = string | BoardContainerRef;

export function catalogBoardItemsFromYDoc(
  containerInput: BoardContainerInput,
  doc: Y.Doc,
  resolvedFolderId?: string | null,
): CatalogBoardItem[] {
  const container = normalizeBoardContainer(containerInput);
  const folderId = resolveFolderIdForContainer(container, resolvedFolderId);
  const map = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  return Array.from(map.entries())
    .map(([id, value]) => ({
      id,
      folderId,
      containerKind: container.kind,
      containerId: container.id,
      membershipKind: value.membership_kind ?? "primary",
      sourceTaskItemId: value.source_task_item_id ?? null,
      itemType: value.item_type,
      itemId: value.item_id,
      x: value.x,
      y: value.y,
      metadata: value.metadata ?? {},
      ...(value.created_at ? { createdAt: value.created_at } : {}),
      ...(value.updated_at ? { updatedAt: value.updated_at } : {}),
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}

export function seedBoardYDocFromCatalog(
  doc: Y.Doc,
  containerInput: BoardContainerInput,
  catalog: CatalogState | null,
): void {
  const container = normalizeBoardContainer(containerInput);
  const items = catalog?.boardItems?.filter((item) => boardItemBelongsToContainer(item, container)) ?? [];
  const map = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  doc.transact(() => {
    for (const item of items) {
      map.set(item.id, toYjsItemValue(item));
      if (item.itemType === "markdown") {
        getOrCreateMarkdownText(doc, item.itemId);
      }
    }
  });
}

export function upsertBoardYjsItem(doc: Y.Doc, boardItem: CatalogBoardItem): void {
  doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).set(boardItem.id, toYjsItemValue(boardItem));
}

export function updateBoardYjsItemPosition(
  doc: Y.Doc,
  boardItemId: string,
  x: number,
  y: number,
  options: { preserveUpdatedAt?: boolean } = {},
): void {
  const map = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const current = map.get(boardItemId);
  if (!current) return;
  map.set(boardItemId, {
    ...current,
    x,
    y,
    ...(!options.preserveUpdatedAt ? { updated_at: new Date().toISOString() } : {}),
  });
}

export function deleteBoardYjsItem(doc: Y.Doc, boardItemId: string): void {
  doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP).delete(boardItemId);
}

export function createMarkdownYjsDocument(
  doc: Y.Doc,
  containerInput: BoardContainerInput,
  input: { title: string; body: string; x: number; y: number; documentId?: string },
  resolvedFolderId?: string | null,
): { document: MarkdownDocument; boardItem: CatalogBoardItem } {
  const container = normalizeBoardContainer(containerInput);
  const folderId = resolveFolderIdForContainer(container, resolvedFolderId);
  const documentId = input.documentId ?? createDocumentId();
  const title = input.title.trim() || "Untitled document";
  const body = input.body;
  const text = getOrCreateMarkdownText(doc, documentId);
  text.delete(0, text.length);
  text.insert(0, body);
  const boardItem: CatalogBoardItem = {
    id: `markdown:${documentId}`,
    folderId,
    containerKind: container.kind,
    containerId: container.id,
    membershipKind: "primary",
    sourceTaskItemId: null,
    itemType: "markdown",
    itemId: documentId,
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
    document: { id: documentId, title, body, version: 1 },
    boardItem,
  };
}

export function getOrCreateMarkdownText(doc: Y.Doc, documentId: string): Y.Text {
  const map = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  let text = map.get(documentId);
  if (!text) {
    text = new Y.Text();
    map.set(documentId, text);
  }
  return text;
}

/** Reads an existing body without mutating an unsynchronized Y.Doc. */
export function getMarkdownYjsText(doc: Y.Doc, documentId: string): Y.Text | null {
  return doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP).get(documentId) ?? null;
}

export function updateMarkdownYjsTitle(doc: Y.Doc, documentId: string, title: string): void {
  const boardItemId = `markdown:${documentId}`;
  const map = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const current = map.get(boardItemId);
  if (!current) return;
  map.set(boardItemId, {
    ...current,
    metadata: {
      ...(current.metadata ?? {}),
      title: title.trim() || "Untitled document",
      version: nextMarkdownVersion(current.metadata),
    },
    updated_at: new Date().toISOString(),
  });
}

export function updateMarkdownYjsBody(doc: Y.Doc, documentId: string, body: string): void {
  const text = getOrCreateMarkdownText(doc, documentId);
  text.delete(0, text.length);
  text.insert(0, body);
  const boardItemId = `markdown:${documentId}`;
  const map = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const current = map.get(boardItemId);
  if (!current) return;
  map.set(boardItemId, {
    ...current,
    metadata: {
      ...(current.metadata ?? {}),
      preview: getMarkdownPreview(body),
      version: nextMarkdownVersion(current.metadata),
    },
    updated_at: new Date().toISOString(),
  });
}

export function getMarkdownPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 180);
}

function toYjsItemValue(item: CatalogBoardItem): BoardYjsItemValue {
  return {
    item_type: item.itemType,
    item_id: item.itemId,
    x: item.x,
    y: item.y,
    ...(item.membershipKind ? { membership_kind: item.membershipKind } : {}),
    ...(item.sourceTaskItemId !== undefined
      ? { source_task_item_id: item.sourceTaskItemId }
      : {}),
    metadata: sanitizeBoardItemMetadata(item.metadata),
    ...(item.createdAt ? { created_at: item.createdAt } : {}),
    ...(item.updatedAt ? { updated_at: item.updatedAt } : {}),
  };
}

function nextMarkdownVersion(metadata: Record<string, unknown> | undefined): number {
  const value = metadata?.version;
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.trunc(value) + 1;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.trunc(parsed) + 1;
  }
  return 2;
}

function sanitizeBoardItemMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const cleaned = { ...(metadata ?? {}) };
  delete cleaned.signedUrl;
  delete cleaned.uploadUrl;
  delete cleaned.uploadUrls;
  delete cleaned.uploadProgress;
  return cleaned;
}

function createDocumentId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeBoardContainer(containerInput: BoardContainerInput): BoardContainerRef {
  if (typeof containerInput === "string") return { kind: "folder", id: containerInput };
  return containerInput;
}

function resolveFolderIdForContainer(
  container: BoardContainerRef,
  resolvedFolderId?: string | null,
): string {
  if (container.kind === "folder") return container.id;
  return resolvedFolderId || container.id;
}

function boardItemBelongsToContainer(
  item: CatalogBoardItem,
  container: BoardContainerRef,
): boolean {
  const itemContainerKind = item.containerKind ?? "folder";
  const itemContainerId = item.containerId ?? item.folderId;
  return itemContainerKind === container.kind && itemContainerId === container.id;
}
