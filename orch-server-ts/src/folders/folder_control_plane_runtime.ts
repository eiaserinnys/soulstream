import { BoardYjsSqlResolver } from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { FolderControlPlaneService } from "./folder_control_plane_service.js";

export function createFolderControlPlaneServiceProvider(
  sqlResolver: LiveDbSqlResolver,
): () => Promise<FolderControlPlaneService> {
  const resolver = new BoardYjsSqlResolver(sqlResolver);
  let service: FolderControlPlaneService | undefined;
  return async () => service ??= new FolderControlPlaneService(await resolver.resolveSql());
}
