import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { listSessionBoardItems } from "../session/session_board_item_inventory.js";
import { BoardYjsSqlResolver, type BoardYjsQuerySql } from "./board_yjs_sql.js";
import { storeMergedBoardYjsApplicationWithSql } from "./board_yjs_snapshot_store.js";
import type { BoardYjsDocumentApplication } from "./board_yjs_types.js";

export class BoardYjsMoveRepository {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async listSessionBoardItems(sessionId: string) {
    return await listSessionBoardItems(await this.sqlResolver.resolveSql(), sessionId);
  }

  async commitBoardItemMove(input: {
    boardApplications: readonly BoardYjsDocumentApplication[];
  }): Promise<void> {
    const sql = await this.sqlResolver.resolveSql();
    await sql.begin(async (transaction) => {
      await persistBoardApplications(transaction, input.boardApplications);
    });
  }

  async commitSessionMove(input: {
    sessionId: string;
    folderId: string | null;
    boardApplications: readonly BoardYjsDocumentApplication[];
  }): Promise<void> {
    const sql = await this.sqlResolver.resolveSql();
    await sql.begin(async (transaction) => {
      await persistBoardApplications(transaction, input.boardApplications);
      await transaction`SELECT session_assign_folder(${input.sessionId}, ${input.folderId})`;
    });
  }
}

async function persistBoardApplications(
  sql: BoardYjsQuerySql,
  applications: readonly BoardYjsDocumentApplication[],
): Promise<void> {
  for (const application of [...applications]
    .sort((left, right) => left.documentName.localeCompare(right.documentName))) {
    await storeMergedBoardYjsApplicationWithSql(sql, application);
  }
}
