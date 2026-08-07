import { Buffer } from "node:buffer";

import * as Y from "yjs";

import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../runtime/live_db_sql.js";
import {
  getBoardYjsContainerDocumentName,
  normalizeBoardYjsDocumentName,
  parseBoardYjsDocumentName,
  readBoardYDocReplica,
  upsertBoardYjsItem,
} from "./board_yjs_model.js";
import {
  BoardYjsSqlResolver,
  type BoardYjsQuerySql,
} from "./board_yjs_sql.js";
import { syncBoardYjsReplicaWithSql } from "./board_yjs_replica_sync.js";
import {
  type BoardYjsRawDocument,
  type BoardYjsRunbookMigrationCommit,
} from "./board_yjs_persistence.js";
import {
  BoardYjsMigrationRevisionConflictError,
  loadExactRawBoardYjsDocument,
} from "./board_yjs_raw_document.js";
import type {
  BoardItemType,
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  BoardYjsReplica,
  BoardYjsSeed,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "./board_yjs_types.js";

export class BoardYjsRepository {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(
    resolver: LiveDbSqlResolver,
    private readonly migrationTransactionSql: BoardYjsQuerySql | null = null,
  ) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async getBoardYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    const sql = await this.sqlResolver.resolveSql();
    const canonicalName = canonicalBoardYjsDocumentName(documentName);
    const rows = await sql<readonly { snapshot: Buffer | Uint8Array }[]>`
      SELECT snapshot FROM board_yjs_documents WHERE name = ${canonicalName}
    `;
    const snapshot = rows[0]?.snapshot;
    return snapshot ? new Uint8Array(snapshot) : null;
  }

  async loadRawBoardYjsDocument(documentName: string): Promise<BoardYjsRawDocument | null> {
    if (this.migrationTransactionSql) {
      return await loadExactRawBoardYjsDocument(
        this.migrationTransactionSql,
        documentName,
        false,
      );
    }
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      return await loadExactRawBoardYjsDocument(transaction, documentName, false);
    });
  }

  async commitBoardYjsRunbookMigration(input: BoardYjsRunbookMigrationCommit): Promise<void> {
    await this.withMigrationTransaction(async (transaction) => {
      const names = [...new Set([
        input.sourceDocumentName,
        input.canonicalDocumentName,
      ])].sort();
      const locked = new Map<string, BoardYjsRawDocument | null>();
      for (const name of names) {
        locked.set(name, await loadExactRawBoardYjsDocument(transaction, name, true));
      }

      const source = locked.get(input.sourceDocumentName) ?? null;
      if (source?.revision !== input.expectedSourceRevision) {
        throw new BoardYjsMigrationRevisionConflictError(input.sourceDocumentName);
      }
      const canonical = locked.get(input.canonicalDocumentName) ?? null;
      if (input.sourceDocumentName !== input.canonicalDocumentName &&
        (canonical?.revision ?? null) !== input.expectedCanonicalRevision) {
        throw new BoardYjsMigrationRevisionConflictError(input.canonicalDocumentName);
      }

      if (input.preserveCanonical) {
        if (!canonical || input.sourceDocumentName === input.canonicalDocumentName) {
          throw new Error("preserveCanonical requires a distinct canonical document");
        }
        await syncBoardYjsReplicaWithSql(
          transaction,
          input.scope,
          input.replica,
          input.canonicalDocumentName,
        );
      } else if (input.sourceDocumentName === input.canonicalDocumentName) {
        await transaction`
          UPDATE board_yjs_documents
          SET snapshot = ${Buffer.from(input.canonicalSnapshot)}, updated_at = NOW()
          WHERE name = ${input.canonicalDocumentName}
        `;
        await syncBoardYjsReplicaWithSql(
          transaction,
          input.scope,
          input.replica,
          input.canonicalDocumentName,
        );
      } else {
        const inserted = await transaction<readonly { name: string }[]>`
          INSERT INTO board_yjs_documents (name, snapshot, updated_at)
          VALUES (
            ${input.canonicalDocumentName},
            ${Buffer.from(input.canonicalSnapshot)},
            NOW()
          )
          ON CONFLICT (name) DO NOTHING
          RETURNING name
        `;
        if (inserted[0]?.name !== input.canonicalDocumentName) {
          throw new BoardYjsMigrationRevisionConflictError(input.canonicalDocumentName);
        }
        await syncBoardYjsReplicaWithSql(
          transaction,
          input.scope,
          input.replica,
          input.canonicalDocumentName,
        );
      }

      if (input.sourceDocumentName !== input.canonicalDocumentName) {
        await transaction`
          DELETE FROM board_yjs_documents WHERE name = ${input.sourceDocumentName}
        `;
      }
    });
  }

  async runBoardYjsRunbookMigrationTransaction<T>(
    operation: (repository: BoardYjsRepository) => Promise<T>,
  ): Promise<T> {
    if (this.migrationTransactionSql) {
      throw new Error("nested board Y.Doc migration transactions are not allowed");
    }
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
      return await operation(new BoardYjsRepository({
        resolveSql: async () => transaction as unknown as LivePostgresSql,
        close: async () => undefined,
      }, transaction));
    });
  }

  async storeBoardYjsSnapshot(documentName: string, snapshot: Uint8Array): Promise<void> {
    const sql = await this.sqlResolver.resolveSql();
    const canonicalName = canonicalBoardYjsDocumentName(documentName);
    await sql`
      INSERT INTO board_yjs_documents (name, snapshot, updated_at)
      VALUES (${canonicalName}, ${Buffer.from(snapshot)}, NOW())
      ON CONFLICT (name) DO UPDATE
      SET snapshot = EXCLUDED.snapshot,
          updated_at = EXCLUDED.updated_at
    `;
  }

  async resolveBoardYjsContainerScope(
    containerInput: string | BoardYjsContainerRef | BoardYjsContainerScope,
  ): Promise<BoardYjsContainerScope | null> {
    if (typeof containerInput !== "string" && "folderId" in containerInput) {
      return containerInput;
    }
    const container = normalizeBoardYjsContainerInput(containerInput);
    if (container.containerKind === "folder") {
      return {
        folderId: container.containerId,
        containerKind: "folder",
        containerId: container.containerId,
      };
    }
    const sql = this.migrationTransactionSql ?? await this.sqlResolver.resolveSql();
    const rows = await sql<readonly { folder_id: string }[]>`
      SELECT bi.folder_id
      FROM tasks r
      JOIN board_items bi ON bi.id = r.board_item_id
      WHERE r.id = ${container.containerId}
      LIMIT 1
    `;
    const folderId = rows[0]?.folder_id;
    return folderId
      ? { folderId, containerKind: container.containerKind, containerId: container.containerId }
      : null;
  }

  private async withMigrationTransaction<T>(
    operation: (transaction: BoardYjsQuerySql) => Promise<T>,
  ): Promise<T> {
    if (this.migrationTransactionSql) {
      return await operation(this.migrationTransactionSql);
    }
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(operation);
  }

  async markBoardYjsDocumentSynced(documentName: string): Promise<void> {
    const sql = await this.sqlResolver.resolveSql();
    await sql`
      UPDATE board_yjs_documents
      SET synced_at = COALESCE(synced_at, NOW())
      WHERE name = ${canonicalBoardYjsDocumentName(documentName)}
    `;
  }

  async loadBoardYjsSeed(
    containerInput: string | BoardYjsContainerRef | BoardYjsContainerScope,
  ): Promise<BoardYjsSeed> {
    const scope = await this.resolveBoardYjsContainerScope(containerInput);
    if (!scope) return { boardItems: [], markdownDocuments: [] };
    const sql = await this.sqlResolver.resolveSql();
    await sql`SELECT board_seed_items()`;
    const rows = await sql<readonly BoardItemDbRow[]>`SELECT * FROM board_item_get_all()`;
    const boardItems = rows
      .map(toCatalogBoardItemRow)
      .filter((item) =>
        item.containerKind === scope.containerKind && item.containerId === scope.containerId
      );
    const markdownIds = boardItems
      .filter((item) => item.itemType === "markdown")
      .map((item) => item.itemId);
    return {
      boardItems,
      markdownDocuments: markdownIds.length === 0
        ? []
        : await this.loadMarkdownDocuments(sql, markdownIds),
    };
  }

  async syncBoardYjsReplica(
    containerInput: string | BoardYjsContainerRef | BoardYjsContainerScope,
    replica: BoardYjsReplica,
    documentName?: string,
  ): Promise<void> {
    const scope = await this.resolveBoardYjsContainerScope(containerInput);
    if (!scope) return;
    const canonicalName = documentName
      ? canonicalBoardYjsDocumentName(documentName)
      : getBoardYjsContainerDocumentName(scope);
    const sql = await this.sqlResolver.resolveSql();
    if (replica.boardItems.length === 0 && !(await this.hasBoardYjsDocumentSynced(sql, canonicalName))) {
      return;
    }
    await sql.begin(async (transaction) => {
      await syncBoardYjsReplicaWithSql(transaction, scope, replica, canonicalName);
    });
  }

  async backfillTaskBoardItemsIntoSnapshot(
    documentName: string,
    containerInput: string | BoardYjsContainerRef | BoardYjsContainerScope,
    snapshot: Uint8Array,
  ): Promise<Uint8Array> {
    const scope = await this.resolveBoardYjsContainerScope(containerInput);
    if (!scope || scope.containerKind !== "folder") return snapshot;
    const sql = await this.sqlResolver.resolveSql();
    const taskItems = await this.loadTaskBoardItems(sql, scope);
    if (taskItems.length === 0) return snapshot;
    const doc = new Y.Doc();
    if (snapshot.byteLength > 0) Y.applyUpdate(doc, snapshot);
    const replica = readBoardYDocReplica(scope, doc);
    const existingIds = new Set(replica.boardItems.map((item) => item.id));
    const missing = taskItems.filter((item) => !existingIds.has(item.id));
    if (missing.length === 0) return snapshot;
    doc.transact(() => {
      for (const item of missing) upsertBoardYjsItem(doc, item);
    });
    const repaired = Y.encodeStateAsUpdate(doc);
    await this.storeBoardYjsSnapshot(documentName, repaired);
    await this.syncBoardYjsReplica(scope, readBoardYDocReplica(scope, doc), documentName);
    return repaired;
  }

  private async loadMarkdownDocuments(
    sql: BoardYjsQuerySql,
    markdownIds: string[],
  ): Promise<MarkdownDocumentRow[]> {
    const rows = await sql<readonly MarkdownDbRow[]>`
      SELECT * FROM markdown_documents WHERE id = ANY(${sql.array(markdownIds)})
    `;
    return rows.map(toMarkdownDocumentRow);
  }

  private async loadTaskBoardItems(
    sql: BoardYjsQuerySql,
    scope: BoardYjsContainerScope,
  ): Promise<CatalogBoardItemRow[]> {
    const rows = await sql<readonly BoardItemDbRow[]>`
      SELECT
        id, folder_id, container_kind, container_id, membership_kind,
        source_task_item_id, item_type, item_id, x, y, metadata, created_at, updated_at
      FROM board_items
      WHERE container_kind = ${scope.containerKind}
        AND container_id = ${scope.containerId}
        AND item_type = 'task'
      ORDER BY y ASC, x ASC, id ASC
    `;
    return rows.map(toCatalogBoardItemRow);
  }

  private async hasBoardYjsDocumentSynced(
    sql: BoardYjsQuerySql,
    documentName: string,
  ): Promise<boolean> {
    const rows = await sql<readonly { synced: boolean }[]>`
      SELECT synced_at IS NOT NULL AS synced
      FROM board_yjs_documents
      WHERE name = ${documentName}
      LIMIT 1
    `;
    return rows[0]?.synced === true;
  }
}

interface BoardItemDbRow extends Record<string, unknown> {
  id: string;
  folder_id: string;
  container_kind?: "folder" | "task" | null;
  container_id?: string | null;
  membership_kind?: "primary" | "reference" | null;
  source_task_item_id?: string | null;
  item_type: BoardItemType;
  item_id: string;
  x: string | number;
  y: string | number;
  metadata: unknown;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface MarkdownDbRow extends Record<string, unknown> {
  id: string;
  title: string;
  body: string;
  version: string | number | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

function toCatalogBoardItemRow(row: BoardItemDbRow): CatalogBoardItemRow {
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
    metadata: recordFromDb(row.metadata),
    ...(toIsoString(row.created_at) ? { createdAt: toIsoString(row.created_at) } : {}),
    ...(toIsoString(row.updated_at) ? { updatedAt: toIsoString(row.updated_at) } : {}),
  };
}

function toMarkdownDocumentRow(row: MarkdownDbRow): MarkdownDocumentRow {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    version: normalizeVersion(row.version),
    ...(toIsoString(row.created_at) ? { createdAt: toIsoString(row.created_at) } : {}),
    ...(toIsoString(row.updated_at) ? { updatedAt: toIsoString(row.updated_at) } : {}),
  };
}

function recordFromDb(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toIsoString(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeVersion(value: string | number | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 1;
}

function canonicalBoardYjsDocumentName(documentName: string): string {
  return normalizeBoardYjsDocumentName(documentName) ?? documentName;
}

function normalizeBoardYjsContainerInput(
  containerInput: string | BoardYjsContainerRef,
): BoardYjsContainerRef {
  return typeof containerInput === "string"
    ? { containerKind: "folder", containerId: containerInput }
    : containerInput;
}
