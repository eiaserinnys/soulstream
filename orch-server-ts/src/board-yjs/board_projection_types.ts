import type {
  BoardItemType,
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "./board_yjs_types.js";

export type { BoardItemType, BoardYjsContainerRef, BoardYjsContainerScope };

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

export interface ChecklistProjectionOutboxRow extends Record<string, unknown> {
  block_id: string;
  page_id: string;
  source_hash: string;
  actor_kind: ProjectionActorKind;
  actor_session_id: string | null;
  actor_user_id: string | null;
  routing_session_id: string;
  attempts: number;
}

export interface ContainerSessionRecord {
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

export interface ContainerMarkdownRecord {
  id: string;
  title: string;
  body: string;
  updatedAt: string | null;
}

export interface ContainerTitleRecord {
  id: string;
  title: string | null;
  updatedAt: string | null;
}

export interface ContainerItemRecord {
  boardItem: CatalogBoardItemRow;
  archived: boolean;
  session?: ContainerSessionRecord;
  markdown?: ContainerMarkdownRecord;
  task?: ContainerTitleRecord;
  customView?: ContainerTitleRecord;
  asset?: ContainerTitleRecord;
  subfolder?: { id: string; title: string | null };
}

export interface ListContainerItemsParams {
  container: BoardYjsContainerRef;
  query: string | null;
  includeArchived: boolean;
  itemTypes: BoardItemType[] | null;
  limit: number;
  cursor: number;
  scanLimit?: number | null;
}

export interface ListContainerItemsResult {
  items: ContainerItemRecord[];
  total: number;
  counts: Record<BoardItemType, number>;
  scan: { limit: number; scannedItems: number; truncated: boolean } | null;
}

export interface BoardProjectionHost {
  getBoardItems(): Promise<CatalogBoardItemRow[]>;
  getBoardItemById(boardItemId: string): Promise<CatalogBoardItemRow | null>;
  getPrimarySessionBoardItem(sessionId: string): Promise<CatalogBoardItemRow | null>;
  getMarkdownDocumentBoardItem(documentId: string): Promise<CatalogBoardItemRow | null>;
  getBoardItemIdsForSession(sessionId: string): Promise<string[]>;
  listContainerItems(params: ListContainerItemsParams): Promise<ListContainerItemsResult>;
  resolveBoardYjsContainerScope(
    container: BoardYjsContainerRef,
  ): Promise<BoardYjsContainerScope | null>;
  getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null>;
  getCustomView(customViewId: string): Promise<CustomViewWithBoardItem | null>;
  listCustomViews(params: {
    container: BoardYjsContainerRef;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<CustomViewWithBoardItem[]>;
  createCustomViewRecord(
    input: CreateCustomViewRecordInput,
  ): Promise<CustomViewRecordMutationResult>;
  patchCustomViewRecord(
    input: PatchCustomViewRecordInput,
  ): Promise<CustomViewRecordMutationResult>;
  claimChecklistTaskProjections(
    nodeId: string,
    limit?: number,
    leaseMs?: number,
  ): Promise<ChecklistProjectionOutboxRow[]>;
  markChecklistTaskProjectionSuccess(
    row: ChecklistProjectionOutboxRow,
    nodeId: string,
  ): Promise<boolean>;
  markChecklistTaskProjectionFailure(
    row: ChecklistProjectionOutboxRow,
    nodeId: string,
    error: string,
  ): Promise<void>;
}
