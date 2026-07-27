import type { SessionCatalogProvider } from "../session/session_catalog_routes.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import { broadcastCatalogSnapshot } from "./live_folder_mutation_broadcaster.js";
import { deletedBoardItemsDelta } from "./catalog_delta_broadcaster.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";

export function withSessionCatalogMutationBroadcasts(
  provider: SessionCatalogProvider,
  folderProvider: LiveFolderProvider,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
): SessionCatalogProvider {
  const broadcastSessions = async (sessionIds: readonly string[]) => {
    const sessionsDelta = await folderProvider.listSessionAssignmentsByIds(sessionIds);
    await broadcastCatalogSnapshot(folderProvider, broadcaster, { sessionsDelta });
  };
  return {
    ...provider,
    async renameSession(sessionId, displayName, callerInfo) {
      await provider.renameSession(sessionId, displayName, callerInfo);
      await broadcastSessions([sessionId]);
    },
    async moveSessionsToFolder(sessionIds, folderId, callerInfo) {
      const result = await provider.moveSessionsToFolder(sessionIds, folderId, callerInfo);
      await broadcastSessions(sessionIds);
      return result;
    },
    async updateSessionCatalog(sessionId, update, callerInfo) {
      await provider.updateSessionCatalog(sessionId, update, callerInfo);
      await broadcastSessions([sessionId]);
    },
    async deleteSession(sessionId, callerInfo) {
      const deletedBoardItemIds =
        await folderProvider.listBoardItemIdsForSessionDeletion(sessionId);
      await provider.deleteSession(sessionId, callerInfo);
      await broadcastCatalogSnapshot(folderProvider, broadcaster, {
        sessionsDelta: { [sessionId]: null },
        boardItemsDelta: deletedBoardItemsDelta(deletedBoardItemIds),
      });
    },
  };
}
