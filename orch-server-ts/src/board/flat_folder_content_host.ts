import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type { SessionFolderMoveService } from "../session/session_folder_move_service.js";
import { CustomViewProjectionRepository } from "./custom_view_repository.js";
import { FolderContentRepository } from "./folder_content_repository.js";
import { FolderContentSqlResolver } from "./folder_content_sql.js";
import { toCatalogBoardItemRow, type BoardItemDbRow } from "./folder_content_serialization.js";
import type { MarkdownDocumentService } from "./markdown_document_service.js";
import type { CatalogBoardItemRow } from "./folder_content_types.js";

export class FlatFolderContentHost {
  readonly reads: FolderContentRepository;
  readonly customViews: CustomViewProjectionRepository;
  private readonly sqlResolver: FolderContentSqlResolver;

  constructor(resolver: LiveDbSqlResolver, readonly documents: MarkdownDocumentService,
    readonly sessions: SessionFolderMoveService,
    private readonly moveFolder: (folderId: string, targetFolderId: string, idempotencyKey: string) => Promise<void>,
    private readonly notifyMove: (item: CatalogBoardItemRow, previousFolderId: string, sessionIds?: readonly string[]) => Promise<void>) {
    this.reads = new FolderContentRepository(resolver);
    this.customViews = new CustomViewProjectionRepository(resolver);
    this.sqlResolver = new FolderContentSqlResolver(resolver);
  }

  async moveBoardItem(boardItemId: string, targetFolderId: string, idempotencyKey: string): Promise<CatalogBoardItemRow> {
    const item = await this.reads.getBoardItemById(boardItemId);
    if (!item) throw Object.assign(new Error("Board item not found"), { statusCode: 404 });
    if ((item.membershipKind ?? "primary") !== "primary") throw Object.assign(new Error("Only primary membership can be moved"), { statusCode: 422 });
    if (item.itemType === "markdown") return await this.documents.move(item.itemId, targetFolderId);
    if (item.folderId === targetFolderId) return item;
    let moved: CatalogBoardItemRow;
    let sessionIds: readonly string[] | undefined;
    if (item.itemType === "session") {
      const result = await this.sessions.moveSessionsToFolder([item.itemId], targetFolderId);
      sessionIds = result.sessionIds;
      moved = { ...item, folderId: targetFolderId };
    } else if (item.itemType === "subfolder") {
      await this.moveFolder(item.itemId, targetFolderId, idempotencyKey);
      moved = { ...item, folderId: targetFolderId };
    } else if (item.itemType === "asset" || item.itemType === "custom_view") {
      const sql = await this.sqlResolver.resolveSql();
      const rows = await sql<readonly BoardItemDbRow[]>`
        UPDATE board_items SET folder_id = ${targetFolderId}, updated_at = NOW() WHERE id = ${item.id} RETURNING *
      `;
      if (!rows[0]) throw Object.assign(new Error("Board item not found"), { statusCode: 404 });
      moved = toCatalogBoardItemRow(rows[0]);
    } else throw Object.assign(new Error("Board item type is not movable"), { statusCode: 422 });
    await this.notifyMove(moved, item.folderId, sessionIds);
    return moved;
  }

  async upsertCustomViewBoardItem(input: {
    folderId: string; boardItemId: string; customViewId: string; title: string; html: string;
    revision: number; x: number; y: number; metadata?: Record<string, unknown>;
  }) {
    const sql = await this.sqlResolver.resolveSql();
    const metadata = { ...input.metadata, title: input.title,
      preview: input.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180), revision: input.revision };
    const rows = await sql<readonly BoardItemDbRow[]>`
      INSERT INTO board_items (id, folder_id, item_type, item_id, x, y, metadata)
      VALUES (${input.boardItemId}, ${input.folderId}, 'custom_view', ${input.customViewId}, ${input.x}, ${input.y}, ${sql.json(metadata)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW() RETURNING *
    `;
    return toCatalogBoardItemRow(rows[0]!);
  }

  async removeBoardItem(folderId: string, boardItemId: string): Promise<void> {
    const sql = await this.sqlResolver.resolveSql();
    await sql`DELETE FROM board_items WHERE id = ${boardItemId} AND folder_id = ${folderId}`;
  }
}
