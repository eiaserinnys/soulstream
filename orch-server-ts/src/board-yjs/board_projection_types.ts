import type {
  BoardItemType,
  BoardYjsFolderScope,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "./board_yjs_types.js";

export type { BoardItemType, BoardYjsFolderScope };

export interface CustomViewRow {
  id: string;
  boardItemId: string;
  title: string | null;
  html: string;
  revision: number;
  archived: boolean;
  createdActorKind: ProjectionActorKind;
  createdSessionId: string | null;
  createdEventId: number | null;
  updatedActorKind: ProjectionActorKind;
  updatedSessionId: string | null;
  updatedEventId: number | null;
  createdAt?: string;
  updatedAt?: string;
}

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

export class CustomViewRevisionConflictError extends Error {
  readonly customViewId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(customViewId: string, expectedRevision: number, actualRevision: number) {
    super(
      `custom view revision conflict for ${customViewId}: expected ${expectedRevision}, actual ${actualRevision}`,
    );
    this.name = "CustomViewRevisionConflictError";
    this.customViewId = customViewId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export interface FolderSessionRecord {
  agentSessionId: string;
  displayName: string | null;
  lastUserMessagePreview: string | null;
  status: string | null;
  agentId: string | null;
  sessionType: string | null;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  awaySummary: string | null;
  callerSessionId: string | null;
  predecessorSessionId: string | null;
  nodeId: string | null;
  lastEventId: number | null;
  lastReadEventId: number | null;
}

export interface FolderMarkdownRecord {
  id: string;
  title: string;
  body: string;
  updatedAt: string | null;
}

export interface FolderTitleRecord {
  id: string;
  title: string | null;
  updatedAt: string | null;
}

export interface FolderItemRecord {
  boardItem: CatalogBoardItemRow;
  archived: boolean;
  session?: FolderSessionRecord;
  markdown?: FolderMarkdownRecord;
  customView?: FolderTitleRecord;
  asset?: FolderTitleRecord;
  subfolder?: { id: string; title: string | null };
}

export interface ListFolderItemsParams {
  folderId: string;
  query: string | null;
  includeArchived: boolean;
  itemTypes: BoardItemType[] | null;
  limit: number;
  cursor: number;
  scanLimit?: number | null;
}

export interface ListFolderItemsResult {
  items: FolderItemRecord[];
  total: number;
  counts: Record<BoardItemType, number>;
  scan: { limit: number; scannedItems: number; truncated: boolean } | null;
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
  resolveBoardYjsFolderScope(
    container: BoardYjsFolderScope,
  ): Promise<BoardYjsFolderScope | null>;
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
