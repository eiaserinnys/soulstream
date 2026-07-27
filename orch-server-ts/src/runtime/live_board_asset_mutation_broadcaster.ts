import type { BoardAssetRouteProvider } from "../board/board_asset_routes.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";
import { broadcastCatalogDelta } from "./catalog_delta_broadcaster.js";

export function withBoardAssetMutationBroadcasts(
  provider: BoardAssetRouteProvider,
  folderProvider: LiveFolderProvider,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
): BoardAssetRouteProvider {
  return {
    ...provider,
    async commitFileAsset(input) {
      const result = await provider.commitFileAsset(input);
      const boardItem = requireCommittedBoardItem(result);
      await broadcastCatalogDelta(folderProvider, broadcaster, {
        boardItemsDelta: {
          [boardItem.id]: boardItem,
        },
      });
      return result;
    },
  };
}

function requireCommittedBoardItem(result: unknown): Record<string, unknown> & { id: string } {
  if (!isRecord(result) || !isRecord(result.boardItem)) {
    throw new Error("committed board asset result has no board item");
  }
  const id = result.boardItem.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("committed board asset result has no board item id");
  }
  return { ...result.boardItem, id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
