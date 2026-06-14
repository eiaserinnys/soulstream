import {
  getFolderIdFromBoardYjsDocumentName,
} from "../../collaboration/board_yjs_model.js";
import type {
  BoardYjsReplica,
  BoardYjsSeed,
  MarkdownDocumentRow,
  SqlClient,
} from "../session_db_types.js";
import type { BoardRepository } from "./board_repository.js";
import {
  asPostgresJsonValue,
  type RepositorySql,
  toMarkdownDocumentRow,
} from "./repository_helpers.js";

const BOARD_ITEMS_ADVISORY_LOCK_KEY = "soulstream:board_items";

export class BoardYjsRepository {
  constructor(
    private readonly sql: SqlClient,
    private readonly boardRepository: BoardRepository,
  ) {}

  async getBoardYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    const rows = await this.sql<Array<{ snapshot: Buffer | Uint8Array }>>`
      SELECT snapshot FROM board_yjs_documents WHERE name = ${documentName}
    `;
    const snapshot = rows[0]?.snapshot;
    return snapshot ? new Uint8Array(snapshot) : null;
  }

  async storeBoardYjsSnapshot(
    documentName: string,
    snapshot: Uint8Array,
  ): Promise<void> {
    await this.sql`
      INSERT INTO board_yjs_documents (name, snapshot, updated_at)
      VALUES (${documentName}, ${Buffer.from(snapshot)}, NOW())
      ON CONFLICT (name) DO UPDATE
      SET snapshot = EXCLUDED.snapshot,
          updated_at = EXCLUDED.updated_at
    `;
    this.boardRepository.invalidateBoardYjsCatalogCache(
      getFolderIdFromBoardYjsDocumentName(documentName),
    );
  }

  async appendBoardYjsUpdate(
    documentName: string,
    update: Uint8Array,
  ): Promise<void> {
    await this.sql`
      INSERT INTO board_yjs_documents (name, snapshot)
      VALUES (${documentName}, ${Buffer.alloc(0)})
      ON CONFLICT (name) DO NOTHING
    `;
    await this.sql`
      INSERT INTO board_yjs_updates (document_name, update)
      VALUES (${documentName}, ${Buffer.from(update)})
    `;
    this.boardRepository.invalidateBoardYjsCatalogCache(
      getFolderIdFromBoardYjsDocumentName(documentName),
    );
  }

  async getBoardYjsUpdates(documentName: string): Promise<Uint8Array[]> {
    const rows = await this.sql<Array<{ update: Buffer | Uint8Array }>>`
      SELECT update FROM board_yjs_updates
      WHERE document_name = ${documentName}
      ORDER BY id ASC
    `;
    return rows.map((row) => new Uint8Array(row.update));
  }

  async loadBoardYjsSeed(folderId: string): Promise<BoardYjsSeed> {
    await this.boardRepository.ensureBoardItems();
    const boardItems = (await this.boardRepository.getBoardItems()).filter((item) => item.folderId === folderId);
    const markdownIds = boardItems
      .filter((item) => item.itemType === "markdown")
      .map((item) => item.itemId);
    if (markdownIds.length === 0) {
      return { boardItems, markdownDocuments: [] };
    }
    const markdownDocuments = await this.loadMarkdownDocuments(markdownIds);
    return { boardItems, markdownDocuments };
  }

  async syncBoardYjsReplica(
    folderId: string,
    replica: BoardYjsReplica,
  ): Promise<void> {
    this.boardRepository.invalidateBoardYjsCatalogCache(folderId);
    await this.sql.begin(async (sql) => {
      await this.syncBoardYjsReplicaWithSql(sql, folderId, replica);
    });
  }

  private async loadMarkdownDocuments(
    markdownIds: string[],
  ): Promise<MarkdownDocumentRow[]> {
    const rows = await this.sql<
      Array<{
        id: string;
        title: string;
        body: string;
        version: string | number | null;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }>
    >`
      SELECT * FROM markdown_documents WHERE id = ANY(${this.sql.array(markdownIds)})
    `;
    return rows.map(toMarkdownDocumentRow);
  }

  private async syncBoardYjsReplicaWithSql(
    sql: RepositorySql,
    folderId: string,
    replica: BoardYjsReplica,
  ): Promise<void> {
    await this.lockBoardItemsReplica(sql);

    const boardItemIds = replica.boardItems.map((item) => item.id);
    if (boardItemIds.length === 0) {
      await sql`DELETE FROM board_items WHERE folder_id = ${folderId}`;
    } else {
      await sql`
        DELETE FROM board_items
        WHERE folder_id = ${folderId}
          AND id <> ALL(${sql.array(boardItemIds)})
      `;
    }

    for (const item of replica.boardItems) {
      await sql`
        INSERT INTO board_items (id, folder_id, item_type, item_id, x, y, metadata, updated_at)
        VALUES (
          ${item.id},
          ${folderId},
          ${item.itemType},
          ${item.itemId},
          ${item.x},
          ${item.y},
          ${sql.json(asPostgresJsonValue(item.metadata ?? {}))}::jsonb,
          NOW()
        )
        ON CONFLICT (id) DO UPDATE
        SET folder_id = EXCLUDED.folder_id,
            item_type = EXCLUDED.item_type,
            item_id = EXCLUDED.item_id,
            x = EXCLUDED.x,
            y = EXCLUDED.y,
            metadata = EXCLUDED.metadata,
            updated_at = EXCLUDED.updated_at
      `;
    }

    for (const document of replica.markdownDocuments) {
      await sql`
        INSERT INTO markdown_documents (id, title, body, version, updated_at)
        VALUES (${document.id}, ${document.title}, ${document.body}, ${document.version}, NOW())
        ON CONFLICT (id) DO UPDATE
        SET title = EXCLUDED.title,
            body = EXCLUDED.body,
            version = EXCLUDED.version,
            updated_at = EXCLUDED.updated_at
      `;
    }

    await sql`
      INSERT INTO board_yjs_catalog_cache (folder_id, board_items, markdown_documents, updated_at)
      VALUES (
        ${folderId},
        ${sql.json(asPostgresJsonValue(replica.boardItems))}::jsonb,
        ${sql.json(asPostgresJsonValue(replica.markdownDocuments))}::jsonb,
        NOW()
      )
      ON CONFLICT (folder_id) DO UPDATE
      SET board_items = EXCLUDED.board_items,
          markdown_documents = EXCLUDED.markdown_documents,
          updated_at = EXCLUDED.updated_at
    `;
  }

  private async lockBoardItemsReplica(sql: RepositorySql): Promise<void> {
    await sql`
      SELECT pg_advisory_xact_lock(hashtext(${BOARD_ITEMS_ADVISORY_LOCK_KEY})::bigint)
    `;
  }
}
