import type { BoardYjsQuerySql } from "./board_yjs_sql.js";
import type {
  BoardYjsContainerScope,
  BoardYjsReplica,
} from "./board_yjs_types.js";

const BOARD_ITEMS_ADVISORY_LOCK_KEY = "soulstream:board_items";

export async function syncBoardYjsReplicaWithSql(
  sql: BoardYjsQuerySql,
  scope: BoardYjsContainerScope,
  replica: BoardYjsReplica,
  documentName: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${BOARD_ITEMS_ADVISORY_LOCK_KEY})::bigint)`;
  const projectedReplica = await normalizeMissingSourceTaskItemReferences(sql, replica);
  const boardItemIds = projectedReplica.boardItems.map((item) => item.id);
  if (boardItemIds.length === 0) {
    await sql`
      DELETE FROM board_items
      WHERE container_kind = ${scope.containerKind}
        AND container_id = ${scope.containerId}
    `;
  } else {
    await sql`
      DELETE FROM board_items
      WHERE container_kind = ${scope.containerKind}
        AND container_id = ${scope.containerId}
        AND id <> ALL(${sql.array(boardItemIds)})
    `;
  }
  for (const item of projectedReplica.boardItems) {
    await sql`
      INSERT INTO board_items (
        id, folder_id, container_kind, container_id, membership_kind,
        source_task_item_id, item_type, item_id, x, y, metadata, updated_at
      ) VALUES (
        ${item.id}, ${scope.folderId}, ${scope.containerKind}, ${scope.containerId},
        ${item.membershipKind ?? "primary"}, ${item.sourceTaskItemId ?? null},
        ${item.itemType}, ${item.itemId}, ${item.x}, ${item.y},
        ${sql.json(item.metadata ?? {})}::jsonb, NOW()
      )
      ON CONFLICT (id) DO UPDATE
      SET folder_id = EXCLUDED.folder_id,
          container_kind = EXCLUDED.container_kind,
          container_id = EXCLUDED.container_id,
          membership_kind = EXCLUDED.membership_kind,
          source_task_item_id = EXCLUDED.source_task_item_id,
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
      folder_id, container_kind, container_id, board_items, markdown_documents, updated_at
    ) VALUES (
      ${scope.folderId}, ${scope.containerKind}, ${scope.containerId},
      ${sql.json(projectedReplica.boardItems)}::jsonb,
      ${sql.json(projectedReplica.markdownDocuments)}::jsonb,
      NOW()
    )
    ON CONFLICT (container_kind, container_id) DO UPDATE
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

async function normalizeMissingSourceTaskItemReferences(
  sql: BoardYjsQuerySql,
  replica: BoardYjsReplica,
): Promise<BoardYjsReplica> {
  const sourceTaskItemIds = [...new Set(replica.boardItems
    .map((item) => item.sourceTaskItemId)
    .filter((id): id is string => id !== null && id !== undefined))];
  if (sourceTaskItemIds.length === 0) return replica;

  const rows = await sql<readonly TaskItemIdRow[]>`
    SELECT id
    FROM task_items
    WHERE id = ANY(${sql.array(sourceTaskItemIds)})
    FOR KEY SHARE
  `;
  const existingIds = new Set(rows.map((row) => row.id));
  let changed = false;
  const boardItems = replica.boardItems.map((item) => {
    const sourceTaskItemId = item.sourceTaskItemId;
    if (sourceTaskItemId === null || sourceTaskItemId === undefined ||
      existingIds.has(sourceTaskItemId)) {
      return item;
    }
    changed = true;
    return { ...item, sourceTaskItemId: null };
  });

  return changed ? { ...replica, boardItems } : replica;
}

interface TaskItemIdRow extends Record<string, unknown> {
  id: string;
}
