import type { BoardItemType } from "../generated/typescript/index.js";

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
  folderId: string | null;
  title: string;
  body: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CustomViewRow {
  id: string;
  boardItemId: string;
  title: string | null;
  html: string;
  revision: number;
  archived: boolean;
  createdActorKind: "agent" | "user" | "system" | "llm";
  createdSessionId: string | null;
  createdEventId: number | null;
  updatedActorKind: "agent" | "user" | "system" | "llm";
  updatedSessionId: string | null;
  updatedEventId: number | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CustomViewWithBoardItem {
  customView: CustomViewRow;
  boardItem: CatalogBoardItemRow;
}

export interface CustomViewRecordMutationResult {
  customView: CustomViewRow;
  eventId: number | null;
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

export interface CatalogFolderRecord {
  id: string;
  name: string;
  sortOrder: number;
  settings: Record<string, unknown>;
  parentFolderId: string | null;
  projectPageId: string | null;
  createdAt?: string;
}

export type FolderItemCounts = Record<BoardItemType, number>;

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

export interface FolderSubfolderRecord {
  id: string;
  title: string | null;
}

export interface FolderItemRecord {
  boardItem: CatalogBoardItemRow;
  archived: boolean;
  session?: FolderSessionRecord;
  markdown?: FolderMarkdownRecord;
  customView?: FolderTitleRecord;
  asset?: FolderTitleRecord;
  subfolder?: FolderSubfolderRecord;
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
  counts: FolderItemCounts;
  scan: { limit: number; scannedItems: number; truncated: boolean } | null;
}

export type CatalogSessionAssignment = {
  folderId: string | null;
  displayName: string | null;
};

export type CatalogSessionsDelta =
  Record<string, CatalogSessionAssignment | null>;
export type CatalogBoardItemsDelta<T = CatalogBoardItemRow> =
  Record<string, T | null>;

export interface CatalogMutationDelta {
  readonly sessionIds?: readonly string[];
  readonly sessionsDelta?: CatalogSessionsDelta;
  readonly boardItems?: readonly CatalogBoardItemRow[];
  readonly deletedBoardItemIds?: readonly string[];
}

export type CatalogFolderRecordSource = {
  id: string;
  name: string;
  sort_order: number;
  settings: Record<string, unknown>;
  parent_folder_id: string | null;
  project_page_id: string | null;
  created_at?: Date | string;
};

export function serializeCatalogFolders(
  folders: readonly CatalogFolderRecordSource[],
): CatalogFolderRecord[] {
  return folders.map((folder) => {
    const createdAt = folder.created_at instanceof Date
      ? folder.created_at.toISOString()
      : folder.created_at;
    return {
      id: folder.id,
      name: folder.name,
      sortOrder: folder.sort_order,
      settings: folder.settings ?? {},
      parentFolderId: folder.parent_folder_id,
      projectPageId: folder.project_page_id ?? null,
      ...(createdAt ? { createdAt } : {}),
    };
  });
}

export function sessionAssignmentFromRow(
  session: { folder_id: string | null; display_name: string | null },
): CatalogSessionAssignment {
  return {
    folderId: session.folder_id,
    displayName: session.display_name,
  };
}

export function boardItemsDelta(
  boardItems: readonly CatalogBoardItemRow[] = [],
  deletedBoardItemIds: readonly string[] = [],
): CatalogBoardItemsDelta {
  const delta: CatalogBoardItemsDelta = {};
  for (const boardItem of boardItems) delta[boardItem.id] = boardItem;
  for (const boardItemId of deletedBoardItemIds) delta[boardItemId] = null;
  return delta;
}

export class MarkdownDocumentVersionConflictError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion?: number,
  ) {
    super(
      actualVersion === undefined
        ? `markdown document version conflict: ${documentId} expected version ${expectedVersion}`
        : `markdown document version conflict: ${documentId} expected version ${expectedVersion}, actual version ${actualVersion}`,
    );
    this.name = "MarkdownDocumentVersionConflictError";
  }
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
