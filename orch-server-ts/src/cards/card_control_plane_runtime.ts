import { BoardYjsSqlResolver } from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type { InMemorySseReplayBroadcaster, SessionStreamEvent } from "../sse/replay_broadcaster.js";
import { CardControlPlaneService } from "./card_control_plane_service.js";

export function createCardControlPlaneServiceProvider(options: {
  sqlResolver: LiveDbSqlResolver;
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>;
  onFolderHeaderUpdated?: () => Promise<void>;
  warn: (message: string) => void;
}): () => Promise<CardControlPlaneService> {
  const resolver=new BoardYjsSqlResolver(options.sqlResolver);
  let service: CardControlPlaneService | undefined;
  return async () => {
    if (service) return service;
    service=new CardControlPlaneService(await resolver.resolveSql(), {
      async appendEventTx(sql, params) {
        const rows=await sql<readonly { event_append: number }[]>`SELECT event_append(
          ${params.sessionId},${params.eventType},${params.payload},${params.searchableText},${params.createdAt},${params.dedupeKey ?? null}) AS event_append`;
        if (typeof rows[0]?.event_append !== "number") throw new Error("event_append returned no event id");
        return rows[0].event_append;
      },
    }, {
      async emitFolderUpdated(folderId, _sessionId, headerChanged) {
        if (headerChanged) await options.onFolderHeaderUpdated?.();
        options.broadcaster.append({ type: "folder_updated", folderId });
      },
      async emitCardUpdated(cardId, folderId) {
        options.broadcaster.append({ type: "card_updated", cardId, folderId });
      },
    });
    return service;
  };
}
