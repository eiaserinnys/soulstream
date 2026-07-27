import type {
  CatalogBoardItemRow,
  FolderRow,
  SessionRow,
} from "../db/session_db_types.js";

export interface CatalogFolderRecord {
  id: string;
  name: string;
  sortOrder: number;
  settings: Record<string, unknown>;
  parentFolderId: string | null;
  projectPageId: string | null;
  createdAt?: string;
}

export interface CatalogSessionAssignment {
  folderId: string | null;
  displayName: string | null;
}

export type CatalogSessionsDelta =
  Record<string, CatalogSessionAssignment | null>;
export type CatalogBoardItemsDelta =
  Record<string, CatalogBoardItemRow | null>;

export interface CatalogMutationDelta {
  readonly sessionIds?: readonly string[];
  readonly sessionsDelta?: CatalogSessionsDelta;
  readonly boardItems?: readonly CatalogBoardItemRow[];
  readonly deletedBoardItemIds?: readonly string[];
}

export function serializeCatalogFolders(
  folders: readonly FolderRow[],
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
  session: Pick<SessionRow, "folder_id" | "display_name">,
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
