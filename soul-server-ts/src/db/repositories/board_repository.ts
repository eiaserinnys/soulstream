import type {
  BoardItemType,
  CatalogBoardItemRow,
  CatalogFolderRow,
  SqlClient,
} from "../session_db_types.js";
import {
  parseCatalogBoardItems,
  toCatalogBoardItemRow,
} from "./repository_helpers.js";

export class BoardRepository {
  private readonly boardYjsCatalogCache = new Map<string, CatalogBoardItemRow[]>();

  constructor(private readonly sql: SqlClient) {}

  invalidateBoardYjsCatalogCache(folderId?: string | null): void {
    if (folderId) {
      this.boardYjsCatalogCache.delete(folderId);
      return;
    }
    this.boardYjsCatalogCache.clear();
  }

  async getCatalogBoardItemsForCatalog(
    folders: readonly CatalogFolderRow[],
  ): Promise<CatalogBoardItemRow[]> {
    const folderIds = folders.map((folder) => folder.id);
    if (folderIds.length === 0) return [];

    const cachedRows = await this.sql<
      Array<{ folder_id: string; board_items: unknown }>
    >`
      SELECT folder_id, board_items
      FROM board_yjs_catalog_cache
      WHERE folder_id = ANY(${this.sql.array(folderIds)})
    `;
    const result: CatalogBoardItemRow[] = [];
    const cachedFolderIds = new Set<string>();
    for (const row of cachedRows) {
      cachedFolderIds.add(row.folder_id);
      result.push(...parseCatalogBoardItems(row.board_items));
    }

    const missingFolderIds = folderIds.filter((folderId) => !cachedFolderIds.has(folderId));
    if (missingFolderIds.length > 0) {
      const legacyRows = await this.sql<
        Array<{
          id: string;
          folder_id: string;
          item_type: BoardItemType;
          item_id: string;
          x: string | number;
          y: string | number;
          metadata: unknown;
          created_at: Date | string | null;
          updated_at: Date | string | null;
        }>
      >`
        SELECT *
        FROM board_items
        WHERE folder_id = ANY(${this.sql.array(missingFolderIds)})
      `;
      result.push(...legacyRows.map(toCatalogBoardItemRow));
    }

    return result.sort((a, b) => (
      a.folderId.localeCompare(b.folderId) ||
      a.y - b.y ||
      a.x - b.x ||
      a.id.localeCompare(b.id)
    ));
  }

  async ensureBoardItems(): Promise<void> {
    await this.sql`SELECT board_seed_items()`;
  }

  async getBoardItems(): Promise<CatalogBoardItemRow[]> {
    const rows = await this.sql<
      Array<{
        id: string;
        folder_id: string;
        item_type: BoardItemType;
        item_id: string;
        x: string | number;
        y: string | number;
        metadata: unknown;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }>
    >`SELECT * FROM board_item_get_all()`;
    return rows.map(toCatalogBoardItemRow);
  }

  async getBoardItemById(boardItemId: string): Promise<CatalogBoardItemRow | null> {
    const rows = await this.sql<
      Array<{
        id: string;
        folder_id: string;
        item_type: BoardItemType;
        item_id: string;
        x: string | number;
        y: string | number;
        metadata: unknown;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }>
    >`
      SELECT *
      FROM board_items
      WHERE id = ${boardItemId}
      LIMIT 1
    `;
    return rows[0] ? toCatalogBoardItemRow(rows[0]) : null;
  }

  async getMarkdownDocumentBoardItem(documentId: string): Promise<CatalogBoardItemRow | null> {
    const rows = await this.sql<
      Array<{
        id: string;
        folder_id: string;
        item_type: BoardItemType;
        item_id: string;
        x: string | number;
        y: string | number;
        metadata: unknown;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }>
    >`
      SELECT *
      FROM board_items
      WHERE item_type = ${"markdown"}
        AND item_id = ${documentId}
      LIMIT 1
    `;
    return rows[0] ? toCatalogBoardItemRow(rows[0]) : null;
  }

  async updateBoardItemPosition(
    boardItemId: string,
    x: number,
    y: number,
  ): Promise<void> {
    await this.sql`
      UPDATE board_items
      SET x = ${x}, y = ${y}, updated_at = NOW()
      WHERE id = ${boardItemId}
    `;
  }
}
