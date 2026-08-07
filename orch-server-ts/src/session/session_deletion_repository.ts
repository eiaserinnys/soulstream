import { Buffer } from "node:buffer";

import type { BoardItemDbRow } from "../board-yjs/board_projection_serialization.js";
import { toCatalogBoardItemRow } from "../board-yjs/board_projection_serialization.js";
import { syncBoardYjsReplicaWithSql } from "../board-yjs/board_yjs_replica_sync.js";
import { BoardYjsSqlResolver } from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type {
  SessionDeletionRepositoryPort,
} from "./session_deletion_service.js";

export class SessionDeletionRepository implements SessionDeletionRepositoryPort {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async listSessionBoardItems(sessionId: string) {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly BoardItemDbRow[]>`
      SELECT *
      FROM board_items
      WHERE item_type = 'session' AND item_id = ${sessionId}
      ORDER BY container_kind, container_id, id
    `;
    return rows.map(toCatalogBoardItemRow);
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
