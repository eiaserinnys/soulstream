import * as Y from "yjs";

import { normalizeMarkdownVersion } from "./markdown_document_version.js";
import type {
  BoardYjsFolderScope,
  BoardYjsItemValue,
  BoardYjsReplica,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "./board_yjs_types.js";

export const BOARD_YJS_PREFIX = "board-folder:";
export const BOARD_ITEMS_MAP = "boardItems";
export const MARKDOWN_BODIES_MAP = "markdownBodies";

export function getBoardYjsDocumentName(folderId: string): string {
  if (!folderId.trim()) throw new Error("folderId is required");
  return `${BOARD_YJS_PREFIX}${folderId}`;
}

export function getBoardYjsContainerDocumentName(scope: BoardYjsFolderScope): string {
  return getBoardYjsDocumentName(scope.folderId);
}

export function normalizeBoardYjsDocumentName(documentName: string): string | null {
  const scope = parseBoardYjsDocumentName(documentName);
  return scope ? getBoardYjsDocumentName(scope.folderId) : null;
}

export function parseBoardYjsDocumentName(documentName: string): BoardYjsFolderScope | null {
  if (!documentName.startsWith(BOARD_YJS_PREFIX)) return null;
  const folderId = documentName.slice(BOARD_YJS_PREFIX.length);
  return folderId.trim() ? { folderId } : null;
}

export function boardYjsFolderScope(folderId: string): BoardYjsFolderScope {
  if (!folderId.trim()) throw new Error("folderId is required");
  return { folderId };
}

export function getFolderIdFromBoardYjsDocumentName(documentName: string): string | null {
  return parseBoardYjsDocumentName(documentName)?.folderId ?? null;
}

export function createBoardYDocSnapshot(params: {
  folderId: string;
  boardItems: readonly CatalogBoardItemRow[];
  markdownDocuments: readonly MarkdownDocumentRow[];
}): Uint8Array {
  const scope = boardYjsFolderScope(params.folderId);
  const doc = new Y.Doc();
  const boardItems = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const markdownBodies = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  const markdownById = new Map(params.markdownDocuments.map((item) => [item.id, item]));

  doc.transact(() => {
    for (const item of params.boardItems) {
      if (item.folderId !== scope.folderId) continue;
      const metadata = item.metadata ?? {};
      const markdown = item.itemType === "markdown" ? markdownById.get(item.itemId) : undefined;
      boardItems.set(item.id, {
        item_type: item.itemType,
        item_id: item.itemId,
        x: item.x,
        y: item.y,
        ...(item.membershipKind ? { membership_kind: item.membershipKind } : {}),
        ...(item.sourceChecklistItemId !== undefined
          ? { source_checklist_item_id: item.sourceChecklistItemId }
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
  scopeInput: string | BoardYjsFolderScope,
  doc: Y.Doc,
): BoardYjsReplica {
  const scope = typeof scopeInput === "string" ? boardYjsFolderScope(scopeInput) : scopeInput;
  const boardItems = doc.getMap<BoardYjsItemValue>(BOARD_ITEMS_MAP);
  const markdownBodies = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);
  const markdownDocumentsById = new Map<string, MarkdownDocumentRow>();
  const rows: CatalogBoardItemRow[] = [];

  for (const [id, value] of boardItems.entries()) {
    const normalizedValue = value;
    const metadata = normalizedValue.metadata && typeof normalizedValue.metadata === "object"
      ? normalizedValue.metadata
      : {};
    rows.push({
      id,
      folderId: scope.folderId,
      membershipKind: normalizedValue.membership_kind ?? "primary",
      sourceChecklistItemId: normalizedValue.source_checklist_item_id ?? null,
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
  snapshot?: Uint8Array | null;
}): { replica: BoardYjsReplica; snapshot: Uint8Array } {
  const scope = boardYjsFolderScope(params.folderId);
  const doc = new Y.Doc();
  if (params.snapshot && params.snapshot.byteLength > 0) Y.applyUpdate(doc, params.snapshot);
  return { replica: readBoardYDocReplica(scope, doc), snapshot: Y.encodeStateAsUpdate(doc) };
}

