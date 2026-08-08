import { storeMergedBoardYjsApplicationWithSql } from
  "../board-yjs/board_yjs_snapshot_store.js";
import { BoardYjsSqlResolver } from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { listSessionBoardItems } from "./session_board_item_inventory.js";
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
    return await listSessionBoardItems(sql, sessionId);
  }

  async deleteSession(
    input: Parameters<SessionDeletionRepositoryPort["deleteSession"]>[0],
  ): Promise<void> {
    const sql = await this.sqlResolver.resolveSql();
    await sql.begin(async (transaction) => {
      for (const application of [...input.boardApplications]
        .sort((left, right) => left.documentName.localeCompare(right.documentName))) {
        await storeMergedBoardYjsApplicationWithSql(transaction, application);
      }
      await transaction`SELECT session_delete(${input.sessionId})`;
    });
  }
}
