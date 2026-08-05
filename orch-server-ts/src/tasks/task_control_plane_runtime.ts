import { BoardYjsSqlResolver } from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import { TaskControlPlaneService } from "./task_control_plane_service.js";
import type { TaskDbPort } from "./control_plane/task_types.js";
import type { SqlClient } from "./control_plane/task_types.js";

export function createTaskControlPlaneServiceProvider(options: {
  sqlResolver: LiveDbSqlResolver;
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>;
}): () => Promise<TaskControlPlaneService> {
  const resolver = new BoardYjsSqlResolver(options.sqlResolver);
  let service: TaskControlPlaneService | undefined;
  return async () => {
    if (service) return service;
    const sql = await resolver.resolveSql();
    const db: TaskDbPort = {
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
    service = new TaskControlPlaneService(sql as unknown as SqlClient, db, {
      async emitTaskUpdated(_actorSessionId, taskId, boardItemId) {
        options.broadcaster.append({ type: "task_updated", taskId, boardItemId });
      },
    });
    return service;
  };
}
