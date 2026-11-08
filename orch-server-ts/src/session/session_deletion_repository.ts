import { FolderContentSqlResolver } from "../board/folder_content_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type {
  SessionDeletionRepositoryPort,
} from "./session_deletion_service.js";

export class SessionDeletionRepository implements SessionDeletionRepositoryPort {
  private readonly sqlResolver: FolderContentSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new FolderContentSqlResolver(resolver);
  }

  async deleteSession(
    input: Parameters<SessionDeletionRepositoryPort["deleteSession"]>[0],
  ): Promise<void> {
    const sql = await this.sqlResolver.resolveSql();
    await sql.begin(async (transaction) => {
      await transaction`SELECT session_delete(${input.sessionId})`;
    });
  }
}
