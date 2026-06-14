import type {
  CatalogBoardItemRow,
  CatalogFolderRow,
  FolderRow,
  SqlClient,
} from "../session_db_types.js";
import type { BoardRepository } from "./board_repository.js";
import { toIsoString } from "./repository_helpers.js";

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
    const rows = await this.sql<
      { id: string; name: string; sort_order: number; settings: unknown; parent_folder_id: string | null; created_at: Date | string }[]
    >`SELECT id, name, sort_order, settings, parent_folder_id, created_at FROM folders WHERE id = ${folderId}`;
    const row = rows[0];
    if (!row) return null;
    const createdAt = row.created_at ? { created_at: row.created_at } : {};
    return {
      id: row.id,
      name: row.name,
      sort_order: row.sort_order,
      parent_folder_id: row.parent_folder_id,
      ...createdAt,
      settings:
        row.settings && typeof row.settings === "object"
          ? (row.settings as Record<string, unknown>)
          : {},
    };
  }

  async getCatalog(): Promise<{
    folders: CatalogFolderRow[];
    sessions: Record<string, { folderId: string | null; displayName: string | null }>;
    boardItems: CatalogBoardItemRow[];
  }> {
    const folderRows = await this.sql<
      { id: string; name: string; sort_order: number; settings: unknown; parent_folder_id: string | null; created_at: Date | string | null }[]
    >`SELECT * FROM folder_get_all()`;
    const folders = folderRows.map((f) => {
      const createdAt = toIsoString(f.created_at);
      return {
        id: f.id,
        name: f.name,
        sortOrder: f.sort_order,
        parentFolderId: f.parent_folder_id,
        ...(createdAt ? { createdAt } : {}),
        settings: (typeof f.settings === "object" && f.settings !== null
          ? (f.settings as Record<string, unknown>)
          : {}),
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
    const rows = await this.sql<
      Array<{ id: string; name: string; sort_order: number; settings: unknown; parent_folder_id: string | null; created_at: Date | string | null }>
    >`SELECT * FROM folder_get_all()`;
    return rows.map((r) => {
      const createdAt = r.created_at ? { created_at: r.created_at } : {};
      return {
        id: r.id,
        name: r.name,
        sort_order: r.sort_order,
        parent_folder_id: r.parent_folder_id,
        ...createdAt,
        settings:
          r.settings && typeof r.settings === "object"
            ? (r.settings as Record<string, unknown>)
            : {},
      };
    });
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
