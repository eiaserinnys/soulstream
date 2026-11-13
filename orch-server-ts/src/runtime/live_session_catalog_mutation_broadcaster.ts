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
import { deletedBoardItemsDelta, type CatalogBoardItemsDelta } from "./catalog_delta_broadcaster.js";
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
      // 접수(노드가 마저 지움)면 아직 행이 남아 있으므로 지금 지웠다고 알리지 않는다.
      // 노드가 삭제를 끝내면 session_deleted로 화면에 알린다.
      if (outcome === "deleted") {
        await broadcastCatalogSnapshot(folderProvider, broadcaster, {
          sessionsDelta: { [sessionId]: null },
          boardItemsDelta: deletedBoardItemsDelta(deletedBoardItemIds),
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
