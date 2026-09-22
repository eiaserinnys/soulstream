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
  const broadcastSessions = async (sessionIds: readonly string[]) =>
    await broadcastTargetedSessionCatalogDelta(folderProvider, broadcaster, sessionIds);
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

/**
 * Builds the delta from the committed assignment owner instead of trusting a caller's target.
 * Both REST and Board/Yjs paths use this construction; each path owns exactly one invocation.
 */
export async function broadcastTargetedSessionCatalogDelta(
  folderProvider: Pick<LiveFolderProvider, "listFolders" | "listSessionAssignmentsByIds">,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
  sessionIds: readonly string[],
): Promise<void> {
  const sessionsDelta = await folderProvider.listSessionAssignmentsByIds(sessionIds);
  await broadcastCatalogSnapshot(folderProvider, broadcaster, { sessionsDelta });
}
