import { BoardProjectionReadRepository } from "../../../orch-server-ts/src/board-yjs/board_projection_read_repository.js";
import { createLiveDbSqlResolver } from "../../../orch-server-ts/src/runtime/live_db_sql.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";

/** Connects worker tests to the real orchestrator-owned projection read implementation. */
export function configureTestBoardProjectionReadHost(
  db: SessionDB,
  sql: SqlClient,
): BoardProjectionReadRepository {
  const repository = new BoardProjectionReadRepository(
    createLiveDbSqlResolver({ sql: sql as never }),
  );
  db.configureBoardProjectionHost(repository as never);
  return repository;
}
