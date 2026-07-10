import type { BoardAssetRouteProvider } from "../board/board_asset_routes.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";

export function withBoardAssetMutationBroadcasts(
  provider: BoardAssetRouteProvider,
  folderProvider: LiveFolderProvider,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
): BoardAssetRouteProvider {
  return {
    ...provider,
    async commitFileAsset(input) {
      const result = await provider.commitFileAsset(input);
      broadcaster.append({
        type: "catalog_updated",
        catalog: {
          folders: await folderProvider.listFolders(),
          sessions: await folderProvider.listSessionAssignments(),
        },
      });
      return result;
    },
  };
}
