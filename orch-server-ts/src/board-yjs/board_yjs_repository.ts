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
  BOARD_YJS_SNAPSHOT_CAS_MAX_ATTEMPTS,
  BoardYjsSnapshotCasExhaustedError,
  compareAndSwapBoardYjsSnapshotWithSql,
  loadBoardYjsSnapshotWithSql,
  type BoardYjsSnapshotProjection,
  type BoardYjsSnapshotRecord,
} from "./board_yjs_snapshot_store.js";
import type {
  BoardItemType,
  BoardYjsFolderScope,
  BoardYjsReplica,
  BoardYjsSeed,
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "./board_yjs_types.js";

export class BoardYjsRepository {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(
    resolver: LiveDbSqlResolver,
  ) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async getBoardYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    return (await this.loadBoardYjsSnapshot(documentName))?.snapshot ?? null;
  }

  async loadBoardYjsSnapshot(documentName: string): Promise<BoardYjsSnapshotRecord | null> {
    const sql = await this.sqlResolver.resolveSql();
    const canonicalName = canonicalBoardYjsDocumentName(documentName);
    return await loadBoardYjsSnapshotWithSql(sql, canonicalName);
  }

  async storeBoardYjsSnapshot(
    documentName: string,
    snapshot: Uint8Array,
    expectedRevision: number | null,
    projection?: BoardYjsSnapshotProjection,
  ): Promise<BoardYjsSnapshotRecord | null> {
    const sql = await this.sqlResolver.resolveSql();
    const canonicalName = canonicalBoardYjsDocumentName(documentName);
    return await sql.begin(async (transaction) =>
      await compareAndSwapBoardYjsSnapshotWithSql(transaction, {
        documentName: canonicalName,
        snapshot,
        expectedRevision,
        ...(projection ? { projection } : {}),
      })
    );
  }

  async resolveBoardYjsFolderScope(input: string | BoardYjsFolderScope): Promise<BoardYjsFolderScope> {
    return typeof input === "string" ? { folderId: input } : input;
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
    containerInput: string | BoardYjsFolderScope,
  ): Promise<BoardYjsSeed> {
    const scope = await this.resolveBoardYjsFolderScope(containerInput);
    if (!scope) return { boardItems: [], markdownDocuments: [] };
    const sql = await this.sqlResolver.resolveSql();
    await sql`SELECT board_seed_items(${scope.folderId})`;
    const rows = await sql<readonly BoardItemDbRow[]>`
      SELECT * FROM board_item_get_all()
      WHERE folder_id = ${scope.folderId}
    `;
    const boardItems = rows.map(toCatalogBoardItemRow);
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
    containerInput: string | BoardYjsFolderScope,
    replica: BoardYjsReplica,
    documentName?: string,
  ): Promise<void> {
    const scope = await this.resolveBoardYjsFolderScope(containerInput);
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

  private async loadMarkdownDocuments(
    sql: BoardYjsQuerySql,
    markdownIds: string[],
  ): Promise<MarkdownDocumentRow[]> {
    const rows = await sql<readonly MarkdownDbRow[]>`
      SELECT * FROM markdown_documents WHERE id = ANY(${sql.array(markdownIds)})
    `;
    return rows.map(toMarkdownDocumentRow);
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
  membership_kind?: "primary" | "reference" | null;
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
    membershipKind: row.membership_kind ?? "primary",
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

