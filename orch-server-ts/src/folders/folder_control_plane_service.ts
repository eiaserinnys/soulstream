import type { BoardYjsSql } from "../board-yjs/board_yjs_sql.js";

interface FolderRow {
  id: string;
  name: string;
  sort_order: number;
  settings: Record<string, unknown>;
  parent_folder_id: string | null;
  project_page_id: string | null;
  created_at?: Date | string;
}

type FolderDbRow = Omit<FolderRow, "settings"> & { settings: unknown; archived?: boolean };

export class FolderControlPlaneService {
  constructor(private readonly sql: BoardYjsSql) {}

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
      SELECT id, name, sort_order, settings, parent_folder_id, project_page_id, created_at
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

  async updateFolder(
    folderId: string,
    columns: ReadonlyArray<"name" | "sort_order" | "settings" | "parent_folder_id">,
    values: ReadonlyArray<string | null>,
  ): Promise<void> {
    await this.sql`
      SELECT folder_update(${folderId}, ${this.sql.array(columns)}, ${this.sql.array(values)})
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

    const folderIds = folders.map((folder) => folder.id);
    const cacheRows = folderIds.length === 0
      ? []
      : await this.sql<readonly { container_id: string; board_items: unknown }[]>`
          SELECT container_id, board_items
          FROM board_yjs_catalog_cache
          WHERE container_kind = 'folder'
            AND container_id = ANY(${this.sql.array(folderIds)}::text[])
        `;
    const cachedFolderIds = new Set(cacheRows.map((row) => row.container_id));
    const boardItems = cacheRows.flatMap((row) => (
      Array.isArray(row.board_items)
        ? row.board_items.flatMap((item) => normalizeCachedBoardItem(item))
        : []
    ));
    const missingFolderIds = folderIds.filter((id) => !cachedFolderIds.has(id));
    if (missingFolderIds.length > 0) {
      const legacyRows = await this.sql<readonly Record<string, unknown>[]>`
        SELECT * FROM board_items
        WHERE container_kind = 'folder'
          AND container_id = ANY(${this.sql.array(missingFolderIds)}::text[])
      `;
      boardItems.push(...legacyRows.map(legacyBoardItem));
    }
    boardItems.sort((left, right) => (
      String(left.folderId).localeCompare(String(right.folderId)) ||
      Number(left.y) - Number(right.y) ||
      Number(left.x) - Number(right.x) ||
      String(left.id).localeCompare(String(right.id))
    ));
    return {
      folders: folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        sortOrder: folder.sort_order,
        parentFolderId: folder.parent_folder_id,
        projectPageId: folder.project_page_id,
        settings: folder.settings,
        ...(folder.created_at ? { createdAt: new Date(folder.created_at).toISOString() } : {}),
      })),
      sessions,
      boardItems,
    };
  }
}

function normalizeCachedBoardItem(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  return [{
    ...item,
    membershipKind: item.membershipKind ?? "primary",
    sourceTaskItemId: item.sourceTaskItemId ?? null,
  }];
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
    ...(row.created_at ? { created_at: row.created_at } : {}),
  };
}

function legacyBoardItem(row: Record<string, unknown>) {
  return {
    id: row.id,
    folderId: row.folder_id,
    containerKind: row.container_kind ?? "folder",
    containerId: row.container_id ?? row.folder_id,
    membershipKind: row.membership_kind ?? "primary",
    sourceTaskItemId: row.source_task_item_id ?? null,
    itemType: row.item_type,
    itemId: row.item_id,
    x: Number(row.x),
    y: Number(row.y),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    ...(row.created_at ? { createdAt: new Date(row.created_at as string | Date).toISOString() } : {}),
    ...(row.updated_at ? { updatedAt: new Date(row.updated_at as string | Date).toISOString() } : {}),
  };
}
