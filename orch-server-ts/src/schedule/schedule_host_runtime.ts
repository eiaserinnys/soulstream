import { BoardYjsSqlResolver } from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { SoulstreamScheduleRepository } from "./schedule_repository.js";

export function createScheduleRepositoryProvider(
  sqlResolver: LiveDbSqlResolver,
): () => Promise<SoulstreamScheduleRepository> {
  const resolver = new BoardYjsSqlResolver(sqlResolver);
  let repository: SoulstreamScheduleRepository | undefined;
  return async () => repository ??= new SoulstreamScheduleRepository(await resolver.resolveSql());
}
