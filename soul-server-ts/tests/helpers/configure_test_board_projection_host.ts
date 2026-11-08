import { FolderContentRepository } from "../../../orch-server-ts/src/board/folder_content_repository.js";
import { createLiveDbSqlResolver } from "../../../orch-server-ts/src/runtime/live_db_sql.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";

/** Connects worker tests to the real orchestrator-owned projection read implementation. */
export function configureTestBoardProjectionReadHost(
  db: SessionDB,
  sql: SqlClient,
): FolderContentRepository {
  const repository = new FolderContentRepository(
    createLiveDbSqlResolver({ sql: sql as never }),
  );
  db.configureFolderContentHost(repository as never);
  return repository;
}
