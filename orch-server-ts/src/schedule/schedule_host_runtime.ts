import { FolderContentSqlResolver } from "../board/folder_content_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { SoulstreamScheduleRepository } from "./schedule_repository.js";

export function createScheduleRepositoryProvider(
  sqlResolver: LiveDbSqlResolver,
): () => Promise<SoulstreamScheduleRepository> {
  const resolver = new FolderContentSqlResolver(sqlResolver);
  let repository: SoulstreamScheduleRepository | undefined;
  return async () => repository ??= new SoulstreamScheduleRepository(await resolver.resolveSql());
}
