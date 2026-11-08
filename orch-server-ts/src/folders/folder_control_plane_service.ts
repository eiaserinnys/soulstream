import type { FolderContentSql } from "../board/folder_content_sql.js";
import type { CatalogBoardItemRow } from "../board/folder_content_types.js";

interface FolderRow {
  id: string;
  name: string;
  sort_order: number;
  settings: Record<string, unknown>;
  parent_folder_id: string | null;
  project_page_id: string | null;
  created_at?: Date | string;
  archived: boolean;
  status: string;
  version: number;
}

type FolderDbRow = Omit<FolderRow, "settings"> & { settings: unknown; archived?: boolean };

export class FolderControlPlaneService {
  constructor(private readonly sql: FolderContentSql, private readonly getBoardItems: () => Promise<CatalogBoardItemRow[]>) {}

  async assignSessionToFolder(sessionId: string, folderId: string | null): Promise<void> {
    await this.sql`SELECT session_assign_folder(${sessionId}, ${folderId})`;
  }

  async getDefaultFolder(name: string): Promise<{ id: string; name: string } | null> {
    const rows = await this.sql<readonly { id: string; name: string }[]>`
      SELECT * FROM folder_get_default(${name})
    `;
    return rows[0] ?? null;
  }

  async getFolderById(folderId: string): Promise<FolderRow | null> {
    const rows = await this.sql<readonly FolderDbRow[]>`
      SELECT id, name, sort_order, settings, parent_folder_id, project_page_id,
             archived, status, version, created_at
      FROM folders
      WHERE id = ${folderId}
    `;
    return rows[0] ? folderFromRow(rows[0]) : null;
  }

  async getAllFolders(): Promise<FolderRow[]> {
    const rows = await this.sql<readonly FolderDbRow[]>`SELECT * FROM folder_get_all()`;
    return rows.map(folderFromRow);
  }

  async getSessionAssignmentsByIds(sessionIds: readonly string[]) {
    if (sessionIds.length === 0) return [];
    return await this.sql<readonly {
      session_id: string;
      folder_id: string | null;
      display_name: string | null;
    }[]>`
      SELECT session_id, folder_id, display_name
      FROM sessions
      WHERE session_id = ANY(${this.sql.array(sessionIds)}::text[])
      ORDER BY session_id
    `;
  }

  async getCatalog() {
    const folders = await this.getAllFolders();
    const sessionRows = await this.sql<readonly {
      session_id: string;
      folder_id: string | null;
      display_name: string | null;
    }[]>`SELECT * FROM catalog_get_sessions()`;
    const sessions: Record<string, { folderId: string | null; displayName: string | null }> = {};
    for (const row of sessionRows) {
      sessions[row.session_id] = { folderId: row.folder_id, displayName: row.display_name };
    }

    const boardItems = await this.getBoardItems();
    return {
      folders: folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        sortOrder: folder.sort_order,
        parentFolderId: folder.parent_folder_id,
        projectPageId: folder.project_page_id,
        settings: folder.settings,
        archived: folder.archived,
        status: folder.status, version: folder.version,
        ...(folder.created_at ? { createdAt: new Date(folder.created_at).toISOString() } : {}),
      })),
      sessions,
      boardItems,
    };
  }
}

function folderFromRow(row: FolderDbRow): FolderRow {
  return {
    id: row.id,
    name: row.name,
    sort_order: Number(row.sort_order),
    settings: row.settings && typeof row.settings === "object" && !Array.isArray(row.settings)
      ? row.settings as Record<string, unknown>
      : {},
    parent_folder_id: row.parent_folder_id,
    project_page_id: row.project_page_id,
    archived: Boolean(row.archived),
    status: row.status, version: Number(row.version),
    ...(row.created_at ? { created_at: row.created_at } : {}),
  };
}
