export type BoardItemType =
  | "session"
  | "markdown"
  | "subfolder"
  | "asset"
  | "frame"
  | "runbook"
  | "custom_view";

export type BoardContainerKind = "folder" | "runbook";

export interface BoardYjsContainerRef {
  containerKind: BoardContainerKind;
  containerId: string;
}

export interface BoardYjsContainerScope extends BoardYjsContainerRef {
  folderId: string;
}

export interface CatalogBoardItemRow {
  id: string;
  folderId: string;
  containerKind?: BoardContainerKind;
  containerId?: string;
  membershipKind?: "primary" | "reference";
  sourceRunbookItemId?: string | null;
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

export interface MovedBoardYjsItem {
  boardItem: CatalogBoardItemRow;
  value: BoardYjsItemValue;
  markdownBody?: string;
}
