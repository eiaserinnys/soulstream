import * as Y from "yjs";

import {
  getBoardYjsContainerDocumentName,
  normalizeBoardYjsDocumentName,
  parseBoardYjsDocumentName,
  readBoardYDocReplica,
  upsertBoardYjsItem,
} from "../../collaboration/board_yjs_model.js";
import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  BoardYjsReplica,
  BoardYjsSeed,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
  SqlClient,
} from "../session_db_types.js";
import type { BoardRepository } from "./board_repository.js";
import {
  asPostgresJsonValue,
  recordFromDb,
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
    const canonicalName = canonicalBoardYjsDocumentName(documentName);
    const rows = await this.sql<Array<{ snapshot: Buffer | Uint8Array }>>`
      SELECT snapshot FROM board_yjs_documents WHERE name = ${canonicalName}
    `;
    const snapshot = rows[0]?.snapshot;
    return snapshot ? new Uint8Array(snapshot) : null;
  }

  async storeBoardYjsSnapshot(
    documentName: string,
    snapshot: Uint8Array,
  ): Promise<void> {
    const canonicalName = canonicalBoardYjsDocumentName(documentName);
    await this.sql`
      INSERT INTO board_yjs_documents (name, snapshot, updated_at)
      VALUES (${canonicalName}, ${Buffer.from(snapshot)}, NOW())
      ON CONFLICT (name) DO UPDATE
      SET snapshot = EXCLUDED.snapshot,
          updated_at = EXCLUDED.updated_at
    `;
    this.boardRepository.invalidateBoardYjsCatalogCache(parseBoardYjsDocumentName(canonicalName));
  }

  async appendBoardYjsUpdate(
    documentName: string,
    update: Uint8Array,
  ): Promise<void> {
    const canonicalName = canonicalBoardYjsDocumentName(documentName);
    await this.sql`
      INSERT INTO board_yjs_documents (name, snapshot)
      VALUES (${canonicalName}, ${Buffer.alloc(0)})
      ON CONFLICT (name) DO NOTHING
    `;
    await this.sql`
      INSERT INTO board_yjs_updates (document_name, update)
      VALUES (${canonicalName}, ${Buffer.from(update)})
    `;
    this.boardRepository.invalidateBoardYjsCatalogCache(parseBoardYjsDocumentName(canonicalName));
  }

  async getBoardYjsUpdates(documentName: string): Promise<Uint8Array[]> {
    const canonicalName = canonicalBoardYjsDocumentName(documentName);
    const rows = await this.sql<Array<{ update: Buffer | Uint8Array }>>`
      SELECT update FROM board_yjs_updates
      WHERE document_name = ${canonicalName}
      ORDER BY id ASC
    `;
    return rows.map((row) => new Uint8Array(row.update));
  }

  async resolveBoardYjsContainerScope(
    containerInput: string | BoardYjsContainerRef,
  ): Promise<BoardYjsContainerScope | null> {
    const container = normalizeBoardYjsContainerInput(containerInput);
    if (container.containerKind === "folder") {
      return {
        folderId: container.containerId,
        containerKind: "folder",
        containerId: container.containerId,
      };
    }
    const rows = await this.sql<Array<{ folder_id: string }>>`
      SELECT bi.folder_id
      FROM runbooks r
      JOIN board_items bi ON bi.id = r.board_item_id
      WHERE r.id = ${container.containerId}
      LIMIT 1
    `;
    const folderId = rows[0]?.folder_id;
    return folderId
      ? { folderId, containerKind: container.containerKind, containerId: container.containerId }
      : null;
  }

  async markBoardYjsDocumentSynced(documentName: string): Promise<void> {
    const canonicalName = canonicalBoardYjsDocumentName(documentName);
    await this.sql`
      UPDATE board_yjs_documents
      SET synced_at = COALESCE(synced_at, NOW())
      WHERE name = ${canonicalName}
    `;
  }

  async loadBoardYjsSeed(containerInput: string | BoardYjsContainerRef): Promise<BoardYjsSeed> {
    const scope = await this.resolveBoardYjsContainerScope(containerInput);
    if (!scope) return { boardItems: [], markdownDocuments: [] };
    await this.boardRepository.ensureBoardItems();
    const boardItems = (await this.boardRepository.getBoardItems()).filter((item) =>
      item.containerKind === scope.containerKind && item.containerId === scope.containerId
    );
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
    containerInput: string | BoardYjsContainerRef,
    replica: BoardYjsReplica,
    documentName?: string,
  ): Promise<void> {
    const scope = await this.resolveBoardYjsContainerScope(containerInput);
    if (!scope) return;
    const canonicalName = documentName
      ? canonicalBoardYjsDocumentName(documentName)
      : getBoardYjsContainerDocumentName(scope);
    if (replica.boardItems.length === 0 && !(await this.hasBoardYjsDocumentSynced(canonicalName))) {
      return;
    }
    this.boardRepository.invalidateBoardYjsCatalogCache(scope);
    await this.sql.begin(async (sql) => {
      await this.syncBoardYjsReplicaWithSql(sql, scope, replica, canonicalName);
    });
  }

  async backfillRunbookBoardItemsIntoSnapshot(
    documentName: string,
    containerInput: string | BoardYjsContainerRef,
    snapshot: Uint8Array,
  ): Promise<Uint8Array> {
    const scope = await this.resolveBoardYjsContainerScope(containerInput);
    if (!scope || scope.containerKind !== "folder") return snapshot;
    const runbookItems = await this.loadRunbookBoardItems(scope);
    if (runbookItems.length === 0) return snapshot;

    const doc = new Y.Doc();
    if (snapshot.byteLength > 0) {
      Y.applyUpdate(doc, snapshot);
    }
    const replica = readBoardYDocReplica(scope, doc);
    const existingIds = new Set(replica.boardItems.map((item) => item.id));
    const missing = runbookItems.filter((item) => !existingIds.has(item.id));
    if (missing.length === 0) return snapshot;

    doc.transact(() => {
      for (const item of missing) {
        upsertBoardYjsItem(doc, item);
      }
    });
    const repaired = Y.encodeStateAsUpdate(doc);
    await this.storeBoardYjsSnapshot(documentName, repaired);
    await this.syncBoardYjsReplica(scope, readBoardYDocReplica(scope, doc), documentName);
    return repaired;
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

  private async loadRunbookBoardItems(
    scope: BoardYjsContainerScope,
  ): Promise<CatalogBoardItemRow[]> {
    const rows = await this.sql<
      Array<{
        id: string;
        folder_id: string;
        container_kind: "folder";
        container_id: string;
        membership_kind: "primary" | "reference";
        source_runbook_item_id: string | null;
        item_type: "runbook";
        item_id: string;
        x: string | number;
        y: string | number;
        metadata: unknown;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }>
    >`
      SELECT
        id, folder_id, container_kind, container_id, membership_kind,
        source_runbook_item_id, item_type, item_id, x, y, metadata, created_at, updated_at
      FROM board_items
      WHERE container_kind = ${scope.containerKind}
        AND container_id = ${scope.containerId}
        AND item_type = 'runbook'
      ORDER BY y ASC, x ASC, id ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      folderId: row.folder_id,
      containerKind: row.container_kind,
      containerId: row.container_id,
      membershipKind: row.membership_kind,
      sourceRunbookItemId: row.source_runbook_item_id,
      itemType: row.item_type,
      itemId: row.item_id,
      x: Number(row.x),
      y: Number(row.y),
      metadata: recordFromDb(row.metadata),
      ...(toIsoString(row.created_at) ? { createdAt: toIsoString(row.created_at) } : {}),
      ...(toIsoString(row.updated_at) ? { updatedAt: toIsoString(row.updated_at) } : {}),
    }));
  }

  private async syncBoardYjsReplicaWithSql(
    sql: RepositorySql,
    scope: BoardYjsContainerScope,
    replica: BoardYjsReplica,
    documentName: string,
  ): Promise<void> {
    await this.lockBoardItemsReplica(sql);

    const boardItemIds = replica.boardItems.map((item) => item.id);
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

    for (const item of replica.boardItems) {
      await sql`
        INSERT INTO board_items (
          id, folder_id, container_kind, container_id, membership_kind,
          source_runbook_item_id, item_type, item_id, x, y, metadata, updated_at
        )
        VALUES (
          ${item.id},
          ${scope.folderId},
          ${scope.containerKind},
          ${scope.containerId},
          ${item.membershipKind ?? "primary"},
          ${item.sourceRunbookItemId ?? null},
          ${item.itemType},
          ${item.itemId},
          ${item.x},
          ${item.y},
          ${sql.json(asPostgresJsonValue(item.metadata ?? {}))}::jsonb,
          NOW()
        )
        ON CONFLICT (id) DO UPDATE
        SET folder_id = EXCLUDED.folder_id,
            container_kind = EXCLUDED.container_kind,
            container_id = EXCLUDED.container_id,
            membership_kind = EXCLUDED.membership_kind,
            source_runbook_item_id = EXCLUDED.source_runbook_item_id,
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
      INSERT INTO board_yjs_catalog_cache (
        folder_id, container_kind, container_id, board_items, markdown_documents, updated_at
      )
      VALUES (
        ${scope.folderId},
        ${scope.containerKind},
        ${scope.containerId},
        ${sql.json(asPostgresJsonValue(replica.boardItems))}::jsonb,
        ${sql.json(asPostgresJsonValue(replica.markdownDocuments))}::jsonb,
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

  private async lockBoardItemsReplica(sql: RepositorySql): Promise<void> {
    await sql`
      SELECT pg_advisory_xact_lock(hashtext(${BOARD_ITEMS_ADVISORY_LOCK_KEY})::bigint)
    `;
  }

  private async hasBoardYjsDocumentSynced(documentName: string): Promise<boolean> {
    const rows = await this.sql<Array<{ synced: boolean }>>`
      SELECT synced_at IS NOT NULL AS synced
      FROM board_yjs_documents
      WHERE name = ${documentName}
      LIMIT 1
    `;
    return rows[0]?.synced === true;
  }
}

function toIsoString(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function canonicalBoardYjsDocumentName(documentName: string): string {
  return normalizeBoardYjsDocumentName(documentName) ?? documentName;
}

function normalizeBoardYjsContainerInput(
  containerInput: string | BoardYjsContainerRef,
): BoardYjsContainerRef {
  if (typeof containerInput !== "string") return containerInput;
  return { containerKind: "folder", containerId: containerInput };
}
