import { Buffer } from "node:buffer";

import type { BoardItemDbRow } from "../board-yjs/board_projection_serialization.js";
import { toCatalogBoardItemRow } from "../board-yjs/board_projection_serialization.js";
import { syncBoardYjsReplicaWithSql } from "../board-yjs/board_yjs_replica_sync.js";
import { BoardYjsSqlResolver } from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type {
  SessionDeletionRepositoryPort,
} from "./session_deletion_service.js";

interface BoardYjsCatalogCacheDbRow extends Record<string, unknown> {
  folder_id: string;
  container_kind: "folder" | "task";
  container_id: string;
  board_items: unknown;
}

export class SessionDeletionRepository implements SessionDeletionRepositoryPort {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async listSessionBoardItems(sessionId: string) {
    const sql = await this.sqlResolver.resolveSql();
    const projectionRows = await sql<readonly BoardItemDbRow[]>`
      SELECT *
      FROM board_items
      WHERE item_type = 'session' AND item_id = ${sessionId}
      ORDER BY container_kind, container_id, id
    `;
    const cacheRows = await sql<readonly BoardYjsCatalogCacheDbRow[]>`
      SELECT folder_id, container_kind, container_id, board_items
      FROM board_yjs_catalog_cache
      WHERE board_items::text LIKE ${`%${sessionId}%`}
      ORDER BY container_kind, container_id
    `;
    const boardItems = new Map<string, ReturnType<typeof toCatalogBoardItemRow>>();
    for (const row of projectionRows) {
      const boardItem = toCatalogBoardItemRow(row);
      boardItems.set(boardItemKey(boardItem), boardItem);
    }
    for (const cacheRow of cacheRows) {
      for (const boardItem of cachedSessionBoardItems(cacheRow, sessionId)) {
        boardItems.set(boardItemKey(boardItem), boardItem);
      }
    }
    return [...boardItems.values()].sort((left, right) =>
      boardItemKey(left).localeCompare(boardItemKey(right))
    );
  }

  async deleteSession(
    input: Parameters<SessionDeletionRepositoryPort["deleteSession"]>[0],
  ): Promise<void> {
    const sql = await this.sqlResolver.resolveSql();
    await sql.begin(async (transaction) => {
      for (const application of [...input.boardApplications]
        .sort((left, right) => left.documentName.localeCompare(right.documentName))) {
        await transaction`
          INSERT INTO board_yjs_documents (name, snapshot, updated_at)
          VALUES (${application.documentName}, ${Buffer.from(application.snapshot)}, NOW())
          ON CONFLICT (name) DO UPDATE
          SET snapshot = EXCLUDED.snapshot,
              updated_at = EXCLUDED.updated_at
        `;
        await syncBoardYjsReplicaWithSql(
          transaction,
          application.scope,
          application.replica,
          application.documentName,
        );
      }
      await transaction`SELECT session_delete(${input.sessionId})`;
    });
  }
}

function cachedSessionBoardItems(
  cacheRow: BoardYjsCatalogCacheDbRow,
  sessionId: string,
): Array<ReturnType<typeof toCatalogBoardItemRow>> {
  return decodeCachedBoardItems(cacheRow.board_items).flatMap((value) => {
    const itemType = stringValue(value.itemType ?? value.item_type);
    const itemId = stringValue(value.itemId ?? value.item_id);
    const id = stringValue(value.id);
    if (itemType !== "session" || itemId !== sessionId || id === null) return [];
    const membershipKind = stringValue(value.membershipKind ?? value.membership_kind);
    return [{
      id,
      folderId: cacheRow.folder_id,
      containerKind: cacheRow.container_kind,
      containerId: cacheRow.container_id,
      membershipKind: membershipKind === "reference" ? "reference" : "primary",
      sourceTaskItemId: stringValue(
        value.sourceTaskItemId ?? value.source_task_item_id,
      ),
      itemType: "session" as const,
      itemId: sessionId,
      x: numberValue(value.x),
      y: numberValue(value.y),
      metadata: recordValue(value.metadata),
    }];
  });
}

function decodeCachedBoardItems(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") {
    try {
      return decodeCachedBoardItems(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? [item as Record<string, unknown>]
      : []
  );
}

function boardItemKey(boardItem: ReturnType<typeof toCatalogBoardItemRow>): string {
  return `${boardItem.containerKind ?? "folder"}:${boardItem.containerId ?? boardItem.folderId}:${boardItem.id}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return recordValue(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
