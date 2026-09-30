import type { BoardItemType } from "@soulstream/wire-schema";

export type { BoardItemType } from "@soulstream/wire-schema";

export interface BoardYjsFolderScope {
  folderId: string;
}

export interface CatalogBoardItemRow {
  id: string;
  folderId: string;
  membershipKind?: "primary" | "reference";
  itemType: BoardItemType;
  itemId: string;
  x: number;
  y: number;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface MarkdownDocumentRow {
  id: string;
  title: string;
  body: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface BoardYjsSeed {
  boardItems: CatalogBoardItemRow[];
  markdownDocuments: MarkdownDocumentRow[];
}

export interface BoardYjsReplica {
  boardItems: CatalogBoardItemRow[];
  markdownDocuments: MarkdownDocumentRow[];
}

export interface BoardYjsDocumentApplication {
  documentName: string;
  scope: BoardYjsFolderScope;
  snapshot: Uint8Array;
  replica: BoardYjsReplica;
}

export interface BoardYjsItemValue {
  item_type: BoardItemType;
  item_id: string;
  x: number;
  y: number;
  membership_kind?: "primary" | "reference";
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface MovedBoardYjsItem {
  boardItem: CatalogBoardItemRow;
  value: BoardYjsItemValue;
  markdownBody?: string;
}
