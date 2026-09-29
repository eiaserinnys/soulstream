import { BoardYjsSqlResolver } from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import { ChecklistControlPlaneService } from "./task_control_plane_service.js";
import type { FolderDbPort } from "./control_plane/task_types.js";

export function createChecklistControlPlaneServiceProvider(options: {
  sqlResolver: LiveDbSqlResolver;
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>;
  onFolderHeaderUpdated?: () => Promise<void>;
}): () => Promise<ChecklistControlPlaneService> {
  const resolver = new BoardYjsSqlResolver(options.sqlResolver);
  let service: ChecklistControlPlaneService | undefined;
  return async () => {
    if (service) return service;
    const sql = await resolver.resolveSql();
    const db: FolderDbPort = {
      async appendEventTx(transaction, params) {
        const rows = await transaction<readonly { event_append: number }[]>`
          SELECT event_append(
            ${params.sessionId},
            ${params.eventType},
            ${params.payload},
            ${params.searchableText},
            ${params.createdAt},
            ${params.dedupeKey ?? null}
          ) AS event_append
        `;
        const eventId = rows[0]?.event_append;
        if (typeof eventId !== "number") throw new Error("event_append returned no event id");
        return eventId;
      },
    };
    service = new ChecklistControlPlaneService(sql, db, {
      async emitFolderUpdated(folderId, _sessionId, headerChanged) {
        if (headerChanged) await options.onFolderHeaderUpdated?.();
        options.broadcaster.append({ type: "folder_updated", folderId });
      },
    });
    return service;
  };
}
