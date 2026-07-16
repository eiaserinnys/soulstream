import type {
  CatalogBoardItemRow,
  CatalogFolderRow,
  FolderRow,
  SqlClient,
} from "../session_db_types.js";
import type { BoardRepository } from "./board_repository.js";
import { toIsoString } from "./repository_helpers.js";

interface FolderDataRow {
  id: string;
  name: string;
  sort_order: number;
  settings: unknown;
  parent_folder_id: string | null;
  project_page_id: string | null;
  created_at: Date | string | null;
}

/** folder_get_all() returns SETOF folders, including the filtered archived column. */
interface FolderGetAllRow extends FolderDataRow {
  archived: boolean;
}

function toFolderRow(row: FolderDataRow): FolderRow {
  const createdAt = row.created_at ? { created_at: row.created_at } : {};
  return {
    id: row.id,
    name: row.name,
    sort_order: row.sort_order,
    parent_folder_id: row.parent_folder_id,
    project_page_id: row.project_page_id,
    ...createdAt,
    settings:
      row.settings && typeof row.settings === "object"
        ? (row.settings as Record<string, unknown>)
        : {},
  };
}

export class CatalogRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly boardRepository: BoardRepository,
  ) {}

  async assignSessionToFolder(
    sessionId: string,
    folderId: string | null,
  ): Promise<void> {
    await this.sql`
      SELECT session_assign_folder(${sessionId}, ${folderId})
    `;
  }

  async getDefaultFolder(name: string): Promise<{ id: string; name: string } | null> {
    const rows = await this.sql<{ id: string; name: string }[]>`
      SELECT * FROM folder_get_default(${name})
    `;
    return rows[0] ?? null;
  }

  async getFolderById(
    folderId: string,
  ): Promise<FolderRow | null> {
    const rows = await this.sql<FolderDataRow[]>`
      SELECT id, name, sort_order, settings, parent_folder_id, project_page_id, created_at
      FROM folders
      WHERE id = ${folderId}
    `;
    const row = rows[0];
    if (!row) return null;
    return toFolderRow(row);
  }

  async getCatalog(): Promise<{
    folders: CatalogFolderRow[];
    sessions: Record<string, { folderId: string | null; displayName: string | null }>;
    boardItems: CatalogBoardItemRow[];
  }> {
    const folderRows = await this.sql<FolderGetAllRow[]>`
      SELECT * FROM folder_get_all()
    `;
    const folders = folderRows.map((f) => {
      const folder = toFolderRow(f);
      const createdAt = toIsoString(folder.created_at);
      return {
        id: folder.id,
        name: folder.name,
        sortOrder: folder.sort_order,
        parentFolderId: folder.parent_folder_id,
        projectPageId: folder.project_page_id,
        ...(createdAt ? { createdAt } : {}),
        settings: folder.settings,
      };
    });

    const sessionRows = await this.sql<
      { session_id: string; folder_id: string | null; display_name: string | null }[]
    >`SELECT * FROM catalog_get_sessions()`;
    const sessions: Record<string, { folderId: string | null; displayName: string | null }> = {};
    for (const r of sessionRows) {
      sessions[r.session_id] = {
        folderId: r.folder_id,
        displayName: r.display_name,
      };
    }

    const boardItems = await this.boardRepository.getCatalogBoardItemsForCatalog(folders);

    return { folders, sessions, boardItems };
  }

  async getAllFolders(): Promise<FolderRow[]> {
    const rows = await this.sql<FolderGetAllRow[]>`
      SELECT * FROM folder_get_all()
    `;
    return rows.map(toFolderRow);
  }

  async createFolder(
    id: string,
    name: string,
    sortOrder: number,
    parentFolderId: string | null = null,
  ): Promise<void> {
    await this.sql`SELECT folder_create(${id}, ${name}, ${sortOrder}, ${parentFolderId})`;
  }

  async updateFolder(
    folderId: string,
    columns: ReadonlyArray<"name" | "sort_order" | "settings" | "parent_folder_id">,
    values: ReadonlyArray<string | null>,
  ): Promise<void> {
    await this.sql`
      SELECT folder_update(
        ${folderId},
        ${this.sql.array(columns as unknown as string[])},
        ${this.sql.array(values as unknown as (string | null)[])}
      )
    `;
  }

  async deleteFolderById(folderId: string): Promise<void> {
    await this.sql`SELECT folder_delete(${folderId})`;
  }
}
