import type { FolderRouteProvider } from "../folders/folder_routes.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";

export function withFolderMutationBroadcasts(
  provider: FolderRouteProvider,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
): FolderRouteProvider {
  return {
    ...provider,
    async createFolder(name, sortOrder, options) {
      const result = await provider.createFolder(name, sortOrder, options);
      await broadcastCatalog(provider, broadcaster);
      return result;
    },
    async updateFolder(folderId, update) {
      await provider.updateFolder(folderId, update);
      await broadcastCatalog(provider, broadcaster);
    },
    async deleteFolder(folderId) {
      await provider.deleteFolder(folderId);
      await broadcastCatalog(provider, broadcaster);
    },
    async reorderFolders(items) {
      await provider.reorderFolders(items);
      await broadcastCatalog(provider, broadcaster);
    },
  };
}

async function broadcastCatalog(
  provider: FolderRouteProvider,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
): Promise<void> {
  broadcaster.append({
    type: "catalog_updated",
    catalog: {
      folders: await provider.listFolders(),
      sessions: await provider.listSessionAssignments(),
    },
  });
}
