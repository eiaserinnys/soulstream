import type { BoardYjsQuerySql } from "./board_yjs_sql.js";
import type {
  BoardYjsFolderScope,
  BoardYjsReplica,
} from "./board_yjs_types.js";

const BOARD_ITEMS_ADVISORY_LOCK_KEY = "soulstream:board_items";

export async function syncBoardYjsReplicaWithSql(
  sql: BoardYjsQuerySql,
  scope: BoardYjsFolderScope,
  replica: BoardYjsReplica,
  documentName: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${BOARD_ITEMS_ADVISORY_LOCK_KEY})::bigint)`;
  const projectedReplica = replica;
  const boardItemIds = projectedReplica.boardItems.map((item) => item.id);
  if (boardItemIds.length === 0) {
    await sql`
      DELETE FROM board_items
      WHERE folder_id = ${scope.folderId}
    `;
  } else {
    await sql`
      DELETE FROM board_items
      WHERE folder_id = ${scope.folderId}
        AND id <> ALL(${sql.array(boardItemIds)})
    `;
  }
  for (const item of projectedReplica.boardItems) {
    await sql`
      INSERT INTO board_items (
        id, folder_id, membership_kind,
        item_type, item_id, x, y, metadata, updated_at
      ) VALUES (
        ${item.id}, ${scope.folderId},
        ${item.membershipKind ?? "primary"},
        ${item.itemType}, ${item.itemId}, ${item.x}, ${item.y},
        ${sql.json(item.metadata ?? {})}::jsonb, NOW()
      )
      ON CONFLICT (id) DO UPDATE
      SET folder_id = EXCLUDED.folder_id,
          membership_kind = EXCLUDED.membership_kind,
          item_type = EXCLUDED.item_type,
          item_id = EXCLUDED.item_id,
          x = EXCLUDED.x,
          y = EXCLUDED.y,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
    `;
  }
  for (const document of projectedReplica.markdownDocuments) {
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
    INSERT INTO board_yjs_catalog_cache (
      folder_id, board_items, markdown_documents, updated_at
    ) VALUES (
      ${scope.folderId},
      ${sql.json(projectedReplica.boardItems)}::jsonb,
      ${sql.json(projectedReplica.markdownDocuments)}::jsonb,
      NOW()
    )
    ON CONFLICT (folder_id) DO UPDATE
    SET board_items = EXCLUDED.board_items,
        folder_id = EXCLUDED.folder_id,
        markdown_documents = EXCLUDED.markdown_documents,
        updated_at = EXCLUDED.updated_at
  `;
  await sql`
    UPDATE board_yjs_documents
    SET synced_at = COALESCE(synced_at, NOW())
    WHERE name = ${documentName}
  `;
}
