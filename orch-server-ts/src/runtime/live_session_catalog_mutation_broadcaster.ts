import type { SessionCatalogProvider } from "../session/session_catalog_routes.js";
import {
  deleteSessionWithNode,
  type SessionDeleteTransport,
} from "../session/session_delete.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import { broadcastCatalogSnapshot } from "./live_folder_mutation_broadcaster.js";
import { boardItemsDelta, type CatalogBoardItemsDelta } from "../mcp/board_catalog_delta.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";

export function withSessionCatalogMutationBroadcasts(
  provider: SessionCatalogProvider,
  folderProvider: LiveFolderProvider,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
  sessionDeleteTransport: SessionDeleteTransport,
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
      if (result?.didCommit !== false) await broadcastSessions(result?.sessionIds ?? sessionIds);
      return result;
    },
    async updateSessionCatalog(sessionId, update, callerInfo) {
      const result = await provider.updateSessionCatalog(sessionId, update, callerInfo);
      if (result?.didCommit !== false) await broadcastSessions(result?.sessionIds ?? [sessionId]);
      return result;
    },
    async deleteSession(sessionId, callerInfo) {
      const deletedBoardItemIds =
        await folderProvider.listBoardItemIdsForSessionDeletion(sessionId);
      const target = await provider.getSessionDeleteTarget(sessionId);
      const outcome = await deleteSessionWithNode({
        sessionId,
        target,
        transport: sessionDeleteTransport,
        deleteDirectly: (id) => provider.deleteSession(id, callerInfo),
      });
      if (outcome === "deleted") {
        await broadcastCatalogSnapshot(folderProvider, broadcaster, {
          sessionsDelta: { [sessionId]: null },
          boardItemsDelta: boardItemsDelta([], deletedBoardItemIds),
        });
      }
      return outcome;
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
  boardItemsDelta: CatalogBoardItemsDelta = {},
): Promise<void> {
  const sessionsDelta = await folderProvider.listSessionAssignmentsByIds(sessionIds);
  await broadcastCatalogSnapshot(folderProvider, broadcaster, { sessionsDelta, boardItemsDelta });
}
