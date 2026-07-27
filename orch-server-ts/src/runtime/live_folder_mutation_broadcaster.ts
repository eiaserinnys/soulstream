import {
  broadcastCatalogDelta,
  deletedBoardItemsDelta,
  type CatalogDelta,
} from "./catalog_delta_broadcaster.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";

export function withFolderMutationBroadcasts(
  provider: LiveFolderProvider,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
): LiveFolderProvider {
  return {
    ...provider,
    async createFolder(name, sortOrder, options) {
      const result = await provider.createFolder(name, sortOrder, options);
      await broadcastCatalogSnapshot(provider, broadcaster);
      return result;
    },
    async updateFolder(folderId, update) {
      await provider.updateFolder(folderId, update);
      await broadcastCatalogSnapshot(provider, broadcaster);
    },
    async deleteFolder(folderId) {
      const delta = await provider.deleteFolderWithCatalogDelta(folderId);
      await broadcastCatalogSnapshot(provider, broadcaster, {
        sessionsDelta: delta.sessionsDelta,
        boardItemsDelta: deletedBoardItemsDelta(delta.deletedBoardItemIds),
      });
    },
    async reorderFolders(items) {
      await provider.reorderFolders(items);
      await broadcastCatalogSnapshot(provider, broadcaster);
    },
  };
}

export async function broadcastCatalogSnapshot(
  provider: Pick<LiveFolderProvider, "listFolders">,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
  delta: CatalogDelta = {},
): Promise<void> {
  await broadcastCatalogDelta(provider, broadcaster, delta);
}
