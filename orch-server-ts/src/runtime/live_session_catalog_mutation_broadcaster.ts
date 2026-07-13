import type { FolderRouteProvider } from "../folders/folder_routes.js";
import type { SessionCatalogProvider } from "../session/session_catalog_routes.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import { broadcastCatalogSnapshot } from "./live_folder_mutation_broadcaster.js";

export function withSessionCatalogMutationBroadcasts(
  provider: SessionCatalogProvider,
  folderProvider: FolderRouteProvider,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
): SessionCatalogProvider {
  const broadcast = () => broadcastCatalogSnapshot(folderProvider, broadcaster);
  return {
    ...provider,
    async renameSession(sessionId, displayName, callerInfo) {
      await provider.renameSession(sessionId, displayName, callerInfo);
      await broadcast();
    },
    async moveSessionsToFolder(sessionIds, folderId, callerInfo) {
      const result = await provider.moveSessionsToFolder(sessionIds, folderId, callerInfo);
      await broadcast();
      return result;
    },
    async updateSessionCatalog(sessionId, update, callerInfo) {
      await provider.updateSessionCatalog(sessionId, update, callerInfo);
      await broadcast();
    },
    async deleteSession(sessionId, callerInfo) {
      await provider.deleteSession(sessionId, callerInfo);
      await broadcast();
    },
  };
}
