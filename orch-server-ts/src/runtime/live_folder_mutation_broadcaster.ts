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

export async function broadcastCatalogSnapshot(
  provider: Pick<LiveFolderProvider, "listFolders">,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
  delta: CatalogDelta = {},
): Promise<void> {
  await broadcastCatalogDelta(provider, broadcaster, delta);
}
