import type {
  CatalogBoardItemRow,
  CustomViewRow,
  ListFolderItemsParams,
  ListFolderItemsResult,
  MarkdownDocumentRow,
} from "@soulstream/wire-schema/catalog";

export interface CustomViewWithBoardItem {
  customView: CustomViewRow;
  boardItem: CatalogBoardItemRow;
}

export type ProjectionActorKind = "agent" | "user" | "system" | "llm";

export interface CreateCustomViewRecordInput {
  id: string;
  boardItemId: string;
  title: string;
  html: string;
  actorKind: ProjectionActorKind;
  actorSessionId: string | null;
  idempotencyKey: string;
}

export interface PatchCustomViewRecordInput {
  customViewId: string;
  boardItemId: string;
  expectedRevision: number;
  html: string;
  title?: string | null;
  actorKind: ProjectionActorKind;
  actorSessionId: string | null;
  idempotencyKey: string;
}

export interface CustomViewRecordMutationResult {
  customView: CustomViewRow;
  eventId: number | null;
}

export interface BoardProjectionHost {
  getBoardItems(): Promise<CatalogBoardItemRow[]>;
  getBoardItemsByFolder(
    folderId: string,
  ): Promise<CatalogBoardItemRow[]>;
  getBoardItemById(boardItemId: string): Promise<CatalogBoardItemRow | null>;
  getPrimarySessionBoardItem(sessionId: string): Promise<CatalogBoardItemRow | null>;
  getMarkdownDocumentBoardItem(documentId: string): Promise<CatalogBoardItemRow | null>;
  getBoardItemIdsForSession(sessionId: string): Promise<string[]>;
  listFolderItems(params: ListFolderItemsParams): Promise<ListFolderItemsResult>;
  getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null>;
  getCustomView(customViewId: string): Promise<CustomViewWithBoardItem | null>;
  listCustomViews(params: {
    folderId: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<CustomViewWithBoardItem[]>;
  createCustomViewRecord(
    input: CreateCustomViewRecordInput,
  ): Promise<CustomViewRecordMutationResult>;
  patchCustomViewRecord(
    input: PatchCustomViewRecordInput,
  ): Promise<CustomViewRecordMutationResult>;

}
